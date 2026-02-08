const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const exifr = require('exifr');
const Database = require('better-sqlite3');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3456;

// Ensure dirs
for (const d of ['uploads', 'thumbnails']) {
  fs.mkdirSync(path.join(__dirname, d), { recursive: true });
}

// Database setup
const db = new Database(path.join(__dirname, 'photos.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_name TEXT,
    date_taken TEXT,
    latitude REAL,
    longitude REAL,
    location_name TEXT,
    camera TEXT,
    ai_description TEXT,
    ai_tags TEXT,
    album_id INTEGER,
    sort_order INTEGER DEFAULT 0,
    batch_id TEXT,
    processing_status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (album_id) REFERENCES albums(id)
  );
  CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    auto_generated INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Add columns if they don't exist (migration for existing DBs)
try { db.exec('ALTER TABLE photos ADD COLUMN batch_id TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE photos ADD COLUMN processing_status TEXT DEFAULT "pending"'); } catch(e) {}

// ─── Batch tracking ──────────────────────────────────────────
const batches = new Map(); // batchId -> { total, uploaded, processed, analyzing, done, failed, photos: [{id, status}] }

// ─── HEIC detection ──────────────────────────────────────────
function isHeic(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  return ext === '.heic' || ext === '.heif' || file.mimetype === 'image/heic' || file.mimetype === 'image/heif';
}

// ─── Multer config ───────────────────────────────────────────
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'))
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024, files: 500 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = /^image\/(jpeg|png|webp|gif|tiff|heic|heif)$/.test(file.mimetype) ||
      ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.heic', '.heif'].includes(ext);
    cb(null, allowed);
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/thumbnails', express.static(path.join(__dirname, 'thumbnails')));

// ─── Batch upload endpoint ───────────────────────────────────
app.post('/api/upload', upload.array('photos', 500), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.json({ batchId: null, photos: [] });

  const batchId = uuidv4();
  const batch = { total: files.length, uploaded: 0, processed: 0, failed: 0, complete: false, photos: [] };
  batches.set(batchId, batch);

  // Save all files to DB immediately (resilience: photos saved before any processing)
  const results = [];
  const insertStmt = db.prepare('INSERT INTO photos (filename, original_name, batch_id, processing_status) VALUES (?, ?, ?, ?)');

  for (const file of files) {
    const info = insertStmt.run(file.filename, file.originalname, batchId, 'uploaded');
    const photoId = Number(info.lastInsertRowid);
    batch.uploaded++;
    batch.photos.push({ id: photoId, filename: file.filename, originalname: file.originalname, path: file.path, status: 'uploaded' });
    results.push({ id: photoId, filename: file.filename, thumbnail: null });
  }

  res.json({ batchId, count: files.length, photos: results });

  // Start background processing
  processBatch(batchId).catch(e => console.error('Batch processing error:', e));
});

// ─── SSE endpoint for batch status ──────────────────────────
app.get('/api/batch/:id/status', (req, res) => {
  const batchId = req.params.id;
  const batch = batches.get(batchId);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const send = () => {
    const b = batches.get(batchId);
    if (!b) { res.end(); return; }
    res.write(`data: ${JSON.stringify({ total: b.total, uploaded: b.uploaded, processed: b.processed, failed: b.failed, complete: b.complete })}\n\n`);
    if (b.complete) { clearInterval(iv); setTimeout(() => res.end(), 500); }
  };

  send();
  const iv = setInterval(send, 1000);
  req.on('close', () => clearInterval(iv));
});

// ─── Polling fallback for batch status ──────────────────────
app.get('/api/batch/:id/poll', (req, res) => {
  const batch = batches.get(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  res.json({ total: batch.total, uploaded: batch.uploaded, processed: batch.processed, failed: batch.failed, complete: batch.complete });
});

// ─── Background batch processor ─────────────────────────────
async function processBatch(batchId) {
  const batch = batches.get(batchId);
  if (!batch) return;

  // Process in parallel batches of 5
  const CONCURRENCY = 5;
  const photos = batch.photos.slice();

  for (let i = 0; i < photos.length; i += CONCURRENCY) {
    const chunk = photos.slice(i, i + CONCURRENCY);
    await Promise.allSettled(chunk.map(p => processPhoto(batchId, p)));
  }

  batch.complete = true;
  // Clean up batch after 5 minutes
  setTimeout(() => batches.delete(batchId), 5 * 60 * 1000);
}

async function processPhoto(batchId, photoEntry) {
  const batch = batches.get(batchId);
  const { id: photoId, filename, path: filePath, originalname } = photoEntry;
  const updateStatus = db.prepare('UPDATE photos SET processing_status = ? WHERE id = ?');

  try {
    // Step 1: HEIC conversion
    let processedPath = filePath;
    let processedFilename = filename;
    const ext = path.extname(originalname).toLowerCase();

    if (ext === '.heic' || ext === '.heif') {
      try {
        // Try sharp first (works if libvips has HEIF support)
        const jpegFilename = filename.replace(/\.(heic|heif)$/i, '.jpg');
        const jpegPath = path.join(__dirname, 'uploads', jpegFilename);
        await sharp(filePath).jpeg({ quality: 92 }).toFile(jpegPath);
        // Remove original HEIC
        try { fs.unlinkSync(filePath); } catch(e) {}
        processedPath = jpegPath;
        processedFilename = jpegFilename;
        db.prepare('UPDATE photos SET filename = ? WHERE id = ?').run(jpegFilename, photoId);
      } catch(sharpErr) {
        // Fallback: try heic-convert
        try {
          const heicConvert = require('heic-convert');
          const inputBuffer = fs.readFileSync(filePath);
          const jpegBuffer = await heicConvert({ buffer: inputBuffer, format: 'JPEG', quality: 0.92 });
          const jpegFilename = filename.replace(/\.(heic|heif)$/i, '.jpg');
          const jpegPath = path.join(__dirname, 'uploads', jpegFilename);
          fs.writeFileSync(jpegPath, Buffer.from(jpegBuffer));
          try { fs.unlinkSync(filePath); } catch(e) {}
          processedPath = jpegPath;
          processedFilename = jpegFilename;
          db.prepare('UPDATE photos SET filename = ? WHERE id = ?').run(jpegFilename, photoId);
        } catch(heicErr) {
          console.error(`HEIC conversion failed for ${originalname}:`, heicErr.message);
          // Keep original file, continue processing
        }
      }
    }

    // Step 2: EXIF extraction
    updateStatus.run('extracting_exif', photoId);
    let exif = {};
    try { exif = await exifr.parse(processedPath, { gps: true, pick: ['DateTimeOriginal', 'Make', 'Model'] }) || {}; } catch(e) {}

    const dateTaken = exif.DateTimeOriginal ? new Date(exif.DateTimeOriginal).toISOString() : null;
    const lat = exif.latitude || null;
    const lon = exif.longitude || null;
    const camera = [exif.Make, exif.Model].filter(Boolean).join(' ') || null;

    db.prepare('UPDATE photos SET date_taken = ?, latitude = ?, longitude = ?, camera = ? WHERE id = ?')
      .run(dateTaken, lat, lon, camera, photoId);

    // Step 3: Thumbnail generation
    updateStatus.run('generating_thumbnail', photoId);
    const thumbName = 'thumb_' + processedFilename;
    await sharp(processedPath).resize(400, 400, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(path.join(__dirname, 'thumbnails', thumbName));

    // Step 4: Reverse geocode
    if (lat && lon) {
      updateStatus.run('geocoding', photoId);
      try {
        const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=14`, {
          headers: { 'User-Agent': 'PhotoAlbumApp/1.0' }
        });
        const data = await resp.json();
        const loc = data.address ? [data.address.city || data.address.town || data.address.village, data.address.country].filter(Boolean).join(', ') : (data.display_name || '');
        if (loc) db.prepare('UPDATE photos SET location_name = ? WHERE id = ?').run(loc, photoId);
        // Rate limit for Nominatim
        await new Promise(r => setTimeout(r, 1100));
      } catch(e) { console.error('Geocode error:', e.message); }
    }

    // Step 5: AI analysis
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey) {
      updateStatus.run('analyzing', photoId);
      try {
        const imgBuf = await sharp(processedPath).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer();
        const b64 = imgBuf.toString('base64');
        const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'google/gemini-flash-1.5',
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: 'Describe this photo concisely. Include: scene type, people (count/ages), setting, mood, season, activity, time of day. Then provide 5-8 tags. Format: DESCRIPTION: ...\nTAGS: tag1, tag2, ...' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
              ]
            }]
          })
        });
        const data = await resp.json();
        const text = data.choices?.[0]?.message?.content || '';
        const descMatch = text.match(/DESCRIPTION:\s*(.+?)(?:\n|TAGS:)/s);
        const tagsMatch = text.match(/TAGS:\s*(.+)/s);
        const desc = descMatch ? descMatch[1].trim() : text.substring(0, 200);
        const tags = tagsMatch ? tagsMatch[1].trim() : '';
        db.prepare('UPDATE photos SET ai_description = ?, ai_tags = ? WHERE id = ?').run(desc, tags, photoId);
      } catch(e) { console.error('AI analysis error:', e.message); }
    }

    // Step 6: Auto-album assignment
    updateStatus.run('clustering', photoId);
    autoAssignAlbum(photoId);

    // Done
    updateStatus.run('complete', photoId);
    if (batch) batch.processed++;

  } catch(e) {
    console.error(`Processing error for photo ${photoId}:`, e.message);
    updateStatus.run('error', photoId);
    if (batch) batch.failed++;
    if (batch) batch.processed++;
  }
}

function autoAssignAlbum(photoId) {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(photoId);
  if (!photo || photo.album_id) return;

  const dateStr = photo.date_taken ? photo.date_taken.substring(0, 10) : null;

  if (dateStr) {
    const match = db.prepare(`
      SELECT album_id FROM photos 
      WHERE album_id IS NOT NULL AND date_taken LIKE ? || '%'
      ${photo.location_name ? "AND (location_name = ? OR location_name IS NULL)" : ""}
      LIMIT 1
    `).get(...(photo.location_name ? [dateStr, photo.location_name] : [dateStr]));

    if (match) {
      db.prepare('UPDATE photos SET album_id = ? WHERE id = ?').run(match.album_id, photoId);
      return;
    }
  }

  if (photo.ai_tags) {
    const tags = photo.ai_tags.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
    const albums = db.prepare('SELECT DISTINCT a.id, a.name FROM albums a JOIN photos p ON p.album_id = a.id WHERE p.ai_tags IS NOT NULL').all();
    for (const album of albums) {
      const albumPhotos = db.prepare('SELECT ai_tags FROM photos WHERE album_id = ? AND ai_tags IS NOT NULL LIMIT 5').all(album.id);
      for (const ap of albumPhotos) {
        const albumTags = ap.ai_tags.toLowerCase().split(',').map(t => t.trim());
        const overlap = tags.filter(t => albumTags.includes(t)).length;
        if (overlap >= 2) {
          db.prepare('UPDATE photos SET album_id = ? WHERE id = ?').run(album.id, photoId);
          return;
        }
      }
    }
  }

  // Create new album
  let albumName = 'New Album';
  if (photo.ai_tags) {
    const tags = photo.ai_tags.split(',').map(t => t.trim()).filter(Boolean);
    const themeWords = ['beach', 'city', 'nature', 'family', 'food', 'night', 'sunset', 'mountain', 'travel', 'party', 'portrait', 'street', 'garden', 'snow', 'rain', 'indoor', 'outdoor', 'sport', 'architecture', 'animal'];
    const matched = tags.filter(t => themeWords.some(w => t.toLowerCase().includes(w)));
    if (matched.length > 0) {
      albumName = matched.slice(0, 2).map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(' & ');
    } else if (tags.length > 0) {
      albumName = tags.slice(0, 2).map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(' ');
    }
  }
  if (photo.location_name) albumName = photo.location_name.split(',')[0].trim();
  if (photo.date_taken) {
    const d = new Date(photo.date_taken);
    albumName += ` — ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  const r = db.prepare('INSERT INTO albums (name) VALUES (?)').run(albumName);
  db.prepare('UPDATE photos SET album_id = ? WHERE id = ?').run(r.lastInsertRowid, photoId);
}

// ─── API: Get all photos ─────────────────────────────────────
app.get('/api/photos', (req, res) => {
  const photos = db.prepare('SELECT p.*, a.name as album_name FROM photos p LEFT JOIN albums a ON p.album_id = a.id ORDER BY p.date_taken DESC, p.created_at DESC').all();
  res.json(photos.map(p => ({ ...p, thumbnail: 'thumb_' + p.filename })));
});

// ─── API: Get albums ─────────────────────────────────────────
app.get('/api/albums', (req, res) => {
  const albums = db.prepare('SELECT a.*, COUNT(p.id) as photo_count FROM albums a LEFT JOIN photos p ON p.album_id = a.id GROUP BY a.id ORDER BY a.created_at DESC').all();
  res.json(albums);
});

// ─── API: Get album photos ───────────────────────────────────
app.get('/api/albums/:id/photos', (req, res) => {
  const photos = db.prepare('SELECT p.*, a.name as album_name FROM photos p LEFT JOIN albums a ON p.album_id = a.id WHERE p.album_id = ? ORDER BY p.sort_order, p.date_taken').all(req.params.id);
  res.json(photos.map(p => ({ ...p, thumbnail: 'thumb_' + p.filename })));
});

// ─── API: Rename album ───────────────────────────────────────
app.put('/api/albums/:id', (req, res) => {
  db.prepare('UPDATE albums SET name = ?, auto_generated = 0 WHERE id = ?').run(req.body.name, req.params.id);
  res.json({ ok: true });
});

// ─── API: Move photo to album ────────────────────────────────
app.put('/api/photos/:id/move', (req, res) => {
  db.prepare('UPDATE photos SET album_id = ? WHERE id = ?').run(req.body.album_id, req.params.id);
  res.json({ ok: true });
});

// ─── API: Reorder photo ──────────────────────────────────────
app.put('/api/photos/:id/reorder', (req, res) => {
  db.prepare('UPDATE photos SET sort_order = ? WHERE id = ?').run(req.body.sort_order, req.params.id);
  res.json({ ok: true });
});

// ─── API: Create album ──────────────────────────────────────
app.post('/api/albums', (req, res) => {
  const r = db.prepare('INSERT INTO albums (name, auto_generated) VALUES (?, 0)').run(req.body.name || 'Untitled Album');
  res.json({ id: r.lastInsertRowid });
});

// ─── API: Delete album ──────────────────────────────────────
app.delete('/api/albums/:id', (req, res) => {
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album not found' });

  const deletePhotos = req.query.deletePhotos === 'true';

  if (deletePhotos) {
    const photos = db.prepare('SELECT filename FROM photos WHERE album_id = ?').all(req.params.id);
    for (const p of photos) {
      try { fs.unlinkSync(path.join(__dirname, 'uploads', p.filename)); } catch(e) {}
      try { fs.unlinkSync(path.join(__dirname, 'thumbnails', 'thumb_' + p.filename)); } catch(e) {}
    }
    db.prepare('DELETE FROM photos WHERE album_id = ?').run(req.params.id);
  } else {
    db.prepare('UPDATE photos SET album_id = NULL WHERE album_id = ?').run(req.params.id);
  }

  db.prepare('DELETE FROM albums WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── API: Delete photo ──────────────────────────────────────
app.delete('/api/photos/:id', (req, res) => {
  const photo = db.prepare('SELECT filename FROM photos WHERE id = ?').get(req.params.id);
  if (photo) {
    try { fs.unlinkSync(path.join(__dirname, 'uploads', photo.filename)); } catch(e) {}
    try { fs.unlinkSync(path.join(__dirname, 'thumbnails', 'thumb_' + photo.filename)); } catch(e) {}
    db.prepare('DELETE FROM photos WHERE id = ?').run(req.params.id);
  }
  res.json({ ok: true });
});

// ─── API: Export album as ZIP ────────────────────────────────
app.get('/api/albums/:id/export', async (req, res) => {
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album not found' });

  const photos = db.prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY sort_order, date_taken').all(req.params.id);
  if (!photos.length) return res.status(400).json({ error: 'Album is empty' });

  const sanitize = (s) => (s || 'Photo').replace(/[^a-zA-Z0-9 _-]/g, '').substring(0, 60).trim() || 'Photo';
  const albumDir = sanitize(album.name);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${albumDir}.zip"`);

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.pipe(res);
  archive.on('error', (err) => { console.error('Archive error:', err); res.status(500).end(); });

  // Add photos
  const photoEntries = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const imgPath = path.join(__dirname, 'uploads', p.filename);
    if (!fs.existsSync(imgPath)) continue;
    const seq = String(i + 1).padStart(2, '0');
    const desc = sanitize(p.ai_description ? p.ai_description.split(/[.,!?]/)[0] : p.original_name);
    const ext = path.extname(p.filename) || '.jpg';
    const entryName = `${albumDir}/${seq} - ${desc}${ext}`;
    archive.file(imgPath, { name: entryName });
    photoEntries.push({ seq, desc, ext, filename: `${seq} - ${desc}${ext}`, date: p.date_taken, location: p.location_name });
  }

  // Generate index.html
  const indexHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${album.name}</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#fff;margin:0;padding:20px}
h1{text-align:center;margin-bottom:20px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.grid img{width:100%;border-radius:8px;cursor:pointer}.grid .item{text-align:center}
.grid .caption{font-size:12px;color:#aaa;margin-top:4px}</style></head>
<body><h1>${album.name}</h1><div class="grid">${photoEntries.map(e =>
    `<div class="item"><img src="${e.filename}" loading="lazy"><div class="caption">${e.desc}${e.date ? ' • ' + new Date(e.date).toLocaleDateString() : ''}${e.location ? ' • ' + e.location : ''}</div></div>`
  ).join('')}</div></body></html>`;
  archive.append(indexHtml, { name: `${albumDir}/index.html` });

  await archive.finalize();
});

// ─── Photo Book Layout Engine ────────────────────────────────
function generateBookLayout(albumId) {
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(albumId);
  if (!album) return null;

  const photos = db.prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY date_taken, sort_order, created_at').all(albumId);
  if (!photos.length) return { album, pages: [] };

  // Get image dimensions for orientation detection
  const photoData = photos.map(p => {
    let orientation = 'landscape';
    try {
      const meta = sharp(path.join(__dirname, 'uploads', p.filename));
      // We'll use a simple heuristic: check filename or AI tags
    } catch(e) {}
    const tags = (p.ai_tags || '').toLowerCase();
    const hasFaces = tags.includes('people') || tags.includes('portrait') || tags.includes('family') || tags.includes('group') || tags.includes('couple');
    const quality = (hasFaces ? 2 : 0) + (p.ai_description ? 1 : 0) + (p.location_name ? 1 : 0);
    return { ...p, orientation, hasFaces, quality, caption: buildCaption(p) };
  });

  // Async dimensions - for now use sync metadata if available
  // Sort by date
  const pages = [];

  // Date range
  const dates = photoData.filter(p => p.date_taken).map(p => new Date(p.date_taken));
  const minDate = dates.length ? new Date(Math.min(...dates)) : null;
  const maxDate = dates.length ? new Date(Math.max(...dates)) : null;
  const dateRange = minDate ? (maxDate && maxDate - minDate > 86400000
    ? `${minDate.toLocaleDateString('en-US',{month:'long',day:'numeric'})} – ${maxDate.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}`
    : minDate.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})) : '';
  const locations = [...new Set(photoData.map(p => p.location_name).filter(Boolean))];

  // Cover page: best photo
  const bestPhoto = [...photoData].sort((a,b) => b.quality - a.quality)[0];
  pages.push({
    type: 'cover',
    photo: { filename: bestPhoto.filename },
    title: album.name,
    dateRange,
    location: locations.slice(0,2).join(' · ')
  });

  // Layout remaining photos
  const remaining = photoData.filter(p => p.id !== bestPhoto.id);
  let i = 0;
  let lastDate = null;

  while (i < remaining.length) {
    const p = remaining[i];

    // Check for date/location divider
    const pDate = p.date_taken ? p.date_taken.substring(0, 10) : null;
    if (pDate && lastDate && pDate !== lastDate) {
      const daysDiff = Math.abs(new Date(pDate) - new Date(lastDate)) / 86400000;
      if (daysDiff > 1) {
        pages.push({
          type: 'divider',
          date: new Date(pDate).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
          location: p.location_name || ''
        });
      }
    }
    lastDate = pDate;

    const left = remaining.length - i;

    if (left >= 4 && i % 5 === 0) {
      // Feature + supporting (1 large + 2-3 small)
      const count = Math.min(left, 4);
      pages.push({
        type: 'feature',
        photos: remaining.slice(i, i + count).map(ph => ({ filename: ph.filename, caption: ph.caption })),
        caption: remaining[i].caption
      });
      i += count;
    } else if (left >= 3 && i % 3 === 0) {
      // Collage
      const count = Math.min(left, 4);
      pages.push({
        type: 'collage',
        photos: remaining.slice(i, i + count).map(ph => ({ filename: ph.filename, caption: ph.caption })),
        caption: ''
      });
      i += count;
    } else if (left >= 2) {
      // Two-up
      pages.push({
        type: 'twoup',
        photos: remaining.slice(i, i + 2).map(ph => ({ filename: ph.filename, caption: ph.caption }))
      });
      i += 2;
    } else {
      // Full bleed single
      pages.push({
        type: 'fullbleed',
        photos: [{ filename: p.filename, caption: p.caption }]
      });
      i++;
    }
  }

  return { album, pages };
}

function buildCaption(photo) {
  const parts = [];
  if (photo.date_taken) {
    parts.push(new Date(photo.date_taken).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
  }
  if (photo.location_name) parts.push(photo.location_name);
  return parts.join(' · ');
}

app.get('/api/albums/:id/book', (req, res) => {
  const result = generateBookLayout(req.params.id);
  if (!result) return res.status(404).json({ error: 'Album not found' });
  res.json(result);
});

// ─── PDF Generation ──────────────────────────────────────────
app.get('/api/albums/:id/book/pdf', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const result = generateBookLayout(req.params.id);
  if (!result) return res.status(404).json({ error: 'Album not found' });

  const { album, pages } = result;
  if (!pages.length) return res.status(400).json({ error: 'No photos in album' });

  // A4 with 3mm bleed
  const W = 595.28; // A4 width in points
  const H = 841.89; // A4 height in points
  const BLEED = 8.5; // 3mm in points

  const doc = new PDFDocument({ size: [W + BLEED*2, H + BLEED*2], margin: 0, autoFirstPage: false });
  const safeName = (album.name || 'PhotoBook').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'PhotoBook';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
  doc.pipe(res);

  const pw = W + BLEED*2;
  const ph = H + BLEED*2;
  const margin = BLEED + 36; // bleed + inner margin

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    doc.addPage();

    // White background
    doc.rect(0, 0, pw, ph).fill('#ffffff');

    if (page.type === 'cover') {
      // Cover photo centered
      if (page.photo) {
        const imgPath = path.join(__dirname, 'uploads', page.photo.filename);
        if (fs.existsSync(imgPath)) {
          try {
            const imgW = pw - margin*2;
            const imgH = ph * 0.5;
            doc.image(imgPath, margin, margin + 60, { fit: [imgW, imgH], align: 'center', valign: 'center' });
          } catch(e) {}
        }
      }
      // Title
      doc.font('Helvetica').fontSize(28).fillColor('#1d1d1f')
        .text(page.title || '', margin, ph * 0.65, { width: pw - margin*2, align: 'center' });
      // Date + location
      doc.font('Helvetica').fontSize(11).fillColor('#86868b')
        .text([page.dateRange, page.location].filter(Boolean).join('  ·  '), margin, ph * 0.72, { width: pw - margin*2, align: 'center' });

    } else if (page.type === 'fullbleed') {
      const p = page.photos[0];
      const imgPath = path.join(__dirname, 'uploads', p.filename);
      if (fs.existsSync(imgPath)) {
        try { doc.image(imgPath, 0, 0, { cover: [pw, ph] }); } catch(e) {}
      }
      // Caption at bottom
      if (p.caption) {
        doc.rect(0, ph - 50, pw, 50).fill('rgba(0,0,0,0.4)');
        doc.font('Helvetica').fontSize(10).fillColor('#ffffff')
          .text(p.caption, margin, ph - 36, { width: pw - margin*2, align: 'center' });
      }

    } else if (page.type === 'twoup') {
      const imgW = (pw - margin*3) / 2;
      const imgH = ph - margin*2 - 40;
      page.photos.forEach((p, idx) => {
        const imgPath = path.join(__dirname, 'uploads', p.filename);
        if (fs.existsSync(imgPath)) {
          try { doc.image(imgPath, margin + idx * (imgW + margin), margin, { fit: [imgW, imgH], align: 'center', valign: 'center' }); } catch(e) {}
        }
        if (p.caption) {
          doc.font('Helvetica').fontSize(9).fillColor('#86868b')
            .text(p.caption, margin + idx * (imgW + margin), ph - margin - 20, { width: imgW, align: 'center' });
        }
      });

    } else if (page.type === 'feature') {
      const mainP = page.photos[0];
      const mainImgPath = path.join(__dirname, 'uploads', mainP.filename);
      const mainH = (ph - margin*2) * 0.6;
      if (fs.existsSync(mainImgPath)) {
        try { doc.image(mainImgPath, margin, margin, { fit: [pw - margin*2, mainH], align: 'center', valign: 'center' }); } catch(e) {}
      }
      // Supporting photos
      const rest = page.photos.slice(1);
      const smallW = (pw - margin*2 - (rest.length - 1) * 10) / rest.length;
      const smallH = (ph - margin*2) * 0.3;
      rest.forEach((p, idx) => {
        const imgPath = path.join(__dirname, 'uploads', p.filename);
        if (fs.existsSync(imgPath)) {
          try { doc.image(imgPath, margin + idx * (smallW + 10), margin + mainH + 16, { fit: [smallW, smallH], align: 'center', valign: 'center' }); } catch(e) {}
        }
      });
      if (page.caption) {
        doc.font('Helvetica').fontSize(9).fillColor('#86868b')
          .text(page.caption, margin, ph - margin - 10, { width: pw - margin*2, align: 'center' });
      }

    } else if (page.type === 'collage') {
      const cols = 2;
      const rows = Math.ceil(page.photos.length / cols);
      const gap = 10;
      const cellW = (pw - margin*2 - gap) / cols;
      const cellH = (ph - margin*2 - 30 - gap * (rows - 1)) / rows;
      page.photos.forEach((p, idx) => {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        const imgPath = path.join(__dirname, 'uploads', p.filename);
        if (fs.existsSync(imgPath)) {
          try { doc.image(imgPath, margin + col * (cellW + gap), margin + row * (cellH + gap), { fit: [cellW, cellH], align: 'center', valign: 'center' }); } catch(e) {}
        }
      });

    } else if (page.type === 'divider') {
      doc.font('Helvetica').fontSize(22).fillColor('#333333')
        .text(page.date || '', margin, ph * 0.4, { width: pw - margin*2, align: 'center' });
      doc.moveTo(pw/2 - 20, ph * 0.48).lineTo(pw/2 + 20, ph * 0.48).strokeColor('#dddddd').lineWidth(0.5).stroke();
      if (page.location) {
        doc.font('Helvetica').fontSize(11).fillColor('#86868b')
          .text(page.location, margin, ph * 0.5, { width: pw - margin*2, align: 'center' });
      }
    }

    // Page number (skip cover)
    if (pi > 0) {
      doc.font('Helvetica').fontSize(9).fillColor('#bbbbbb')
        .text(String(pi), 0, ph - BLEED - 20, { width: pw, align: 'center' });
    }
  }

  doc.end();
});

app.listen(PORT, () => console.log(`Photo Album app running on http://localhost:${PORT}`));
