const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const exifr = require('exifr');
const Database = require('better-sqlite3');
const PDFDocument = require('pdfkit');
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

// ─── API: Export album as PDF ────────────────────────────────
app.get('/api/albums/:id/pdf', async (req, res) => {
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album not found' });

  const photos = db.prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY sort_order, date_taken').all(req.params.id);
  if (!photos.length) return res.status(400).json({ error: 'Album is empty' });

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${album.name.replace(/[^a-zA-Z0-9 ]/g, '')}.pdf"`);
  doc.pipe(res);

  const pageW = doc.page.width - 100;
  const pageH = doc.page.height - 100;

  // Title page
  doc.fontSize(36).font('Helvetica-Bold').text(album.name, 50, pageH / 3, { align: 'center', width: pageW });
  doc.fontSize(14).font('Helvetica').text(`${photos.length} photos`, 50, pageH / 3 + 60, { align: 'center', width: pageW });
  const dates = photos.filter(p => p.date_taken).map(p => new Date(p.date_taken));
  if (dates.length) {
    const min = new Date(Math.min(...dates));
    const max = new Date(Math.max(...dates));
    doc.fontSize(12).text(`${min.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}${min.getTime() !== max.getTime() ? ' — ' + max.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : ''}`, 50, pageH / 3 + 85, { align: 'center', width: pageW });
  }

  for (let i = 0; i < photos.length; i++) {
    doc.addPage();
    const photo = photos[i];
    const imgPath = path.join(__dirname, 'uploads', photo.filename);
    if (!fs.existsSync(imgPath)) continue;

    try {
      const resized = await sharp(imgPath).resize(1200, 800, { fit: 'inside' }).jpeg({ quality: 90 }).toBuffer();
      const meta = await sharp(resized).metadata();
      const imgW = Math.min(meta.width, pageW);
      const scale = imgW / meta.width;
      const imgH = meta.height * scale;
      const x = 50 + (pageW - imgW) / 2;
      const y = 60;

      doc.image(resized, x, y, { width: imgW, height: imgH });

      const captionY = y + imgH + 20;
      const parts = [];
      if (photo.date_taken) parts.push(new Date(photo.date_taken).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }));
      if (photo.location_name) parts.push(photo.location_name);
      if (parts.length) doc.fontSize(11).font('Helvetica').text(parts.join('  •  '), 50, captionY, { align: 'center', width: pageW });
      if (photo.ai_description) doc.fontSize(9).font('Helvetica-Oblique').fillColor('#666').text(photo.ai_description.substring(0, 150), 50, captionY + 18, { align: 'center', width: pageW }).fillColor('#000');
    } catch(e) { console.error('PDF image error:', e); }
  }

  doc.end();
});

app.listen(PORT, () => console.log(`Photo Album app running on http://localhost:${PORT}`));
