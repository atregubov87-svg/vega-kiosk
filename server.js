'use strict';
/*
 * Vega-M info kiosk — server side.
 *
 * Reads the read-only views (v_kiosk_price / v_kiosk_schedule / v_kiosk_doctors /
 * v_kiosk_doctor_photo) from Archimed, caches them in memory and serves both the
 * JSON API and the static client to the touchscreen PC.
 *
 * If the database is unreachable the last good snapshot from data/ is served,
 * so the kiosk keeps showing data instead of an empty screen.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const compression = require('compression');
const sql = require('mssql');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const LOG_DIR = path.join(ROOT, 'logs');
const CONFIG_PATH = process.env.VEGA_KIOSK_CONFIG ||
  path.join(os.homedir(), '.claude', 'tools', 'db', 'kiosk_config.json');
const PORT = Number(process.env.VEGA_KIOSK_PORT || 8080);

for (const dir of [DATA_DIR, LOG_DIR]) fs.mkdirSync(dir, { recursive: true });

/* ------------------------------------------------------------------ logging */

const LOG_FILE = path.join(LOG_DIR, 'server.log');

function log(level, msg) {
  const line = `${new Date().toISOString()} ${level} ${msg}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* logging must never take the server down */ }
}

/* ------------------------------------------------------------------- config */

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  log('FATAL', `cannot read DB config ${CONFIG_PATH}: ${err.message}`);
  process.exit(1);
}

const [dbHost, dbPort] = String(cfg.server).split(',');
const sqlConfig = {
  server: dbHost,
  port: dbPort ? Number(dbPort) : 1433,
  database: cfg.database,
  user: cfg.user,
  password: cfg.password,
  options: { encrypt: false, trustServerCertificate: true, appName: 'vega-kiosk' },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  connectionTimeout: 15000,
  requestTimeout: 30000,
};

let poolPromise = null;
function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(sqlConfig)
      .connect()
      .then((pool) => {
        log('INFO', 'connected to SQL Server');
        pool.on('error', (err) => log('ERROR', `pool error: ${err.message}`));
        return pool;
      })
      .catch((err) => {
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

/* -------------------------------------------------------------------- feeds */

const today = "CONVERT(date, GETDATE())";

async function query(text) {
  const pool = await getPool();
  const res = await pool.request().query(text);
  return res.recordset;
}

function loadPrice() {
  return query(`
    SELECT SERVICE_ID, CODE, NAME, ALTNAME, PRICE, CATEGORY, GROUP_ID, GROUP_NAME,
           ROOT_GROUP_ID, ROOT_GROUP, ORDER_INDEX, IS_LAB, INFO
      FROM dbo.v_kiosk_price
     ORDER BY ROOT_GROUP_ID, GROUP_NAME, ORDER_INDEX, NAME`);
}

function loadSchedule() {
  const publishedOnly = cfg.schedule && cfg.schedule.showUnpublished === true ? '' : 'WHERE IS_PUBLISHED_WEB = 1';
  return query(`
    SELECT SCHEDULE_ID, CONVERT(char(10), SHIFT_DATE, 23) AS D, WEEKDAY_NUM, WEEKDAY,
           DOCTOR_ID, DOCTOR_NAME, SPECIALTY, ROOM_NAME, ROOM_NUMBER, ROOM_FLOOR,
           CONVERT(char(5), START_TIME, 108) AS T1, CONVERT(char(5), END_TIME, 108) AS T2,
           IS_PUBLISHED_WEB, INFO
      FROM dbo.v_kiosk_schedule
      ${publishedOnly}
     ORDER BY SHIFT_DATE, START_TIME, DOCTOR_NAME`);
}

// Врачи, которых показываем всегда, даже без единой смены в Archimed.
// Угрюмов — выездной нарколог: в базу его смены не заводятся никогда, но в
// справочнике киоска он должен быть виден (решение пользователя 2026-10-29).
const ALWAYS_SHOW_DOCTORS = [
  'Угрюмов Дмитрий Михайлович',
];

// Сравнение ФИО без регистра, лишних пробелов и разницы «ё/е».
function nameKey(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

const ALWAYS_SHOW_KEYS = new Set(ALWAYS_SHOW_DOCTORS.map(nameKey));

async function loadDoctors() {
  // HAS_SCHEDULE — есть ли у врача вообще смены с сегодняшнего дня (опубликованные
  // или нет). Киоск показывает весь справочник Archimed, кроме врачей совсем без
  // расписания: IS_PUBLISHED_WEB значит только «публиковать расписание на сайте».
  const rows = await query(`
    SELECT d.DOCTOR_ID, d.FULLNAME, d.LAST_NAME, d.FIRST_NAME, d.PATRONYMIC, d.SPECIALTY,
           d.BIO, d.EXPERIENCE, d.CATEGORY, d.IS_PUBLISHED_WEB, d.HAS_PHOTO,
           d.IS_CHIEF,   -- роль «Главный врач» в Archimed, клиент рисует плашку
           -- PHOTO_KEY меняется вместе с фото: клиент подставляет его в ?v=,
           -- иначе браузер держит старый снимок сутки (Cache-Control max-age).
           (SELECT CONVERT(char(10), MAX(p.CHANGED_DATE), 23) + '-' +
                   CAST(MAX(DATALENGTH(p.PHOTO)) AS varchar(20))
              FROM dbo.v_kiosk_doctor_photo p
             WHERE p.DOCTOR_ID = d.DOCTOR_ID) AS PHOTO_KEY,
           CAST(CASE WHEN EXISTS (
             SELECT 1 FROM dbo.v_kiosk_schedule s WHERE s.DOCTOR_ID = d.DOCTOR_ID
           ) THEN 1 ELSE 0 END AS bit) AS HAS_SCHEDULE
      FROM dbo.v_kiosk_doctors d
     ORDER BY d.IS_PUBLISHED_WEB DESC, d.FULLNAME`);

  // Исключения из правила «без смен — не показываем»: ставим HAS_SCHEDULE,
  // чтобы клиент не фильтровал (renderDoctors() смотрит только на этот флаг).
  for (const d of rows) {
    if (ALWAYS_SHOW_KEYS.has(nameKey(d.FULLNAME))) d.HAS_SCHEDULE = true;
  }
  return rows;
}

const FEEDS = {
  price: { ttl: 10 * 60 * 1000, load: loadPrice },
  schedule: { ttl: 2 * 60 * 1000, load: loadSchedule },
  doctors: { ttl: 30 * 60 * 1000, load: loadDoctors },
};

const cache = new Map();   // key -> { payload, at, source, error }
const inflight = new Map(); // key -> Promise

function snapshotPath(key) {
  return path.join(DATA_DIR, key + '.json');
}

function readSnapshot(key) {
  try {
    const raw = JSON.parse(fs.readFileSync(snapshotPath(key), 'utf8'));
    return { payload: raw.payload, at: raw.at };
  } catch {
    return null;
  }
}

function writeSnapshot(key, entry) {
  const file = snapshotPath(key);
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ at: entry.at, payload: entry.payload }));
    fs.renameSync(tmp, file);
  } catch (err) {
    log('WARN', `snapshot write failed for ${key}: ${err.message}`);
  }
}

function refreshFeed(key) {
  if (inflight.has(key)) return inflight.get(key);
  const feed = FEEDS[key];
  const job = feed.load()
    .then((payload) => {
      const entry = { payload, at: Date.now(), source: 'db', error: null };
      cache.set(key, entry);
      writeSnapshot(key, entry);
      log('INFO', `feed ${key} refreshed: ${payload.length} rows`);
      return entry;
    })
    .catch((err) => {
      const prev = cache.get(key);
      const entry = prev
        ? { ...prev, source: 'stale', error: err.message }
        : { payload: [], at: 0, source: 'empty', error: err.message };
      cache.set(key, entry);
      log('ERROR', `feed ${key} failed: ${err.message}`);
      return entry;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function getFeed(key) {
  const entry = cache.get(key);
  const fresh = entry && Date.now() - entry.at < FEEDS[key].ttl;
  if (fresh) return entry;
  return refreshFeed(key);
}

/* ---------------------------------------------------------------- photos */

const photoCache = new Map(); // id -> { buf, mime, etag, sig }

function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 6 && buf.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.length > 12 && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return 'image/jpeg';
}

// У врача в DOCTORS_IMAGE бывает несколько строк (например, старое и новое фото),
// поэтому берём самую свежую. Подпись «дата + размер» сверяется на каждом запросе:
// подмена фото видна сразу, а не через сутки, как было со слепым кэшем на 24 ч.
async function photoSig(id) {
  const rows = await query(`
    SELECT TOP 1 CONVERT(char(10), CHANGED_DATE, 23) AS CHANGED,
           DATALENGTH(PHOTO) AS SZ
      FROM dbo.v_kiosk_doctor_photo
     WHERE DOCTOR_ID = ${Number(id)}
     ORDER BY CHANGED_DATE DESC, DATALENGTH(PHOTO) DESC`);
  if (!rows.length) return null;
  return `${rows[0].CHANGED || ''}-${rows[0].SZ || 0}`;
}

async function loadPhoto(id) {
  const hit = photoCache.get(id);
  let sig;
  try {
    sig = await photoSig(id);
  } catch (err) {
    if (hit) return hit; // база недоступна — отдаём копию из памяти
    throw err;
  }
  if (!sig) {
    photoCache.delete(id);
    return null;
  }
  if (hit && hit.sig === sig) return hit;
  const rows = await query(`
    SELECT PHOTO
      FROM dbo.v_kiosk_doctor_photo
     WHERE DOCTOR_ID = ${Number(id)}
     ORDER BY CHANGED_DATE DESC, DATALENGTH(PHOTO) DESC`);
  if (!rows.length || !rows[0].PHOTO) return null;
  const buf = Buffer.isBuffer(rows[0].PHOTO) ? rows[0].PHOTO : Buffer.from(rows[0].PHOTO);
  const entry = {
    buf,
    mime: sniffImage(buf),
    etag: `"${Number(id)}-${sig}"`,
    sig,
  };
  photoCache.set(id, entry);
  return entry;
}

/* ------------------------------------------------------------------- app */

const app = express();
app.disable('x-powered-by');
app.use(compression());

app.get('/api/health', async (req, res) => {
  let dbOk = false;
  try {
    await query('SELECT 1 AS ok');
    dbOk = true;
  } catch { /* reported below */ }
  const feeds = {};
  for (const key of Object.keys(FEEDS)) {
    const e = cache.get(key);
    feeds[key] = e
      ? { rows: e.payload.length, at: new Date(e.at).toISOString(), source: e.source }
      : { rows: 0, at: null, source: 'cold' };
  }
  res.json({ ok: dbOk && Object.values(feeds).every((f) => f.source === 'db'), db: dbOk, feeds });
});

app.get('/api/version', (req, res) => {
  let v = '0';
  try {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const m = html.match(/app\.js\?v=(\d+)/);
    if (m) v = m[1];
  } catch { /* keep 0 */ }
  res.set('Cache-Control', 'no-store');
  res.json({ v });
});

app.get('/api/price', async (req, res) => {
  const e = await getFeed('price');
  res.set('Cache-Control', 'no-store');
  res.json({ updated: e.at, source: e.source, error: e.error, items: e.payload });
});

app.get('/api/schedule', async (req, res) => {
  const e = await getFeed('schedule');
  res.set('Cache-Control', 'no-store');
  res.json({ updated: e.at, source: e.source, error: e.error, items: e.payload });
});

app.get('/api/doctors', async (req, res) => {
  const e = await getFeed('doctors');
  res.set('Cache-Control', 'no-store');
  res.json({ updated: e.at, source: e.source, error: e.error, items: e.payload });
});

app.get('/api/photo/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
  try {
    const photo = await loadPhoto(id);
    if (!photo) return res.status(404).end();
    if (req.headers['if-none-match'] === photo.etag) return res.status(304).end();
    res.set({
      'Content-Type': photo.mime,
      'Content-Length': photo.buf.length,
      'Cache-Control': 'public, max-age=86400',
      ETag: photo.etag,
    });
    res.end(photo.buf);
  } catch (err) {
    log('ERROR', `photo ${id}: ${err.message}`);
    res.status(503).end();
  }
});

// Entry page is never cached, so a new deploy reaches the kiosk on the next reload.
// Assets are versioned with ?v=N in index.html and may be cached for an hour.
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});
app.use(express.static(path.join(ROOT, 'public'), {
  index: false,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders(res, filePath) {
    if (filePath.toLowerCase().endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));
app.use((req, res) => res.status(404).json({ error: 'not found' }));

/* ---------------------------------------------------------------- startup */

function warmUp() {
  for (const key of Object.keys(FEEDS)) {
    const snap = readSnapshot(key);
    if (snap) cache.set(key, { payload: snap.payload, at: snap.at, source: 'snapshot', error: null });
  }
  for (const key of Object.keys(FEEDS)) refreshFeed(key);
}

const server = app.listen(PORT, '0.0.0.0', () => {
  log('INFO', `listening on http://0.0.0.0:${PORT} (db ${cfg.server}/${cfg.database} as ${cfg.user})`);
  warmUp();
});

function shutdown(sig) {
  log('INFO', `${sig} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
