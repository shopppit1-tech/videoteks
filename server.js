import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth as getFirebaseAdminAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const exec = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;
const FIREBASE_PROJECT_ID = 'videoteks-a82c1';
const YOUTUBE_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI || 'https://shopppit1-tech.github.io';
let firebaseAdminAuth = null;
let firebaseDb = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    const adminApp = getApps().find((entry) => entry.name === 'videoteks') || initializeApp({
      credential: cert(serviceAccount),
      projectId: FIREBASE_PROJECT_ID
    }, 'videoteks');
    firebaseAdminAuth = getFirebaseAdminAuth(adminApp);
    firebaseDb = getFirestore(adminApp);
  }
} catch (error) {
  console.error('[firebase] konfigurasi service account tidak valid:', error.message);
}
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const GEMINI_KEY_COOLDOWN_MS = 5 * 60 * 1000;
const INLINE_AUDIO_MAX_BYTES = 12 * 1024 * 1024;
let nextGeminiKeyIndex = 0;
const geminiKeyCooldowns = new Map();
const upload = multer({ dest: path.join(os.tmpdir(), 'videoteks-uploads'), limits: { fileSize: 500 * 1024 * 1024 } });
app.use(express.json({ limit: '2mb' }));
const allowedOrigins = new Set(['https://shopppit1-tech.github.io', 'https://terjemah-video.onrender.com', 'http://localhost:3000', 'http://127.0.0.1:3000']);
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (!origin || !allowedOrigins.has(origin)) return next();
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With');
  res.setHeader('Access-Control-Expose-Headers', 'X-History-Saved, Content-Disposition');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});
app.use(express.static(path.join(process.cwd(), 'public')));

async function requireFirebaseUser(req, res, next) {
  if (!firebaseAdminAuth || !firebaseDb) {
    return res.status(503).json({ error: 'Login dan riwayat belum dikonfigurasi. Admin Firebase perlu ditambahkan di environment server.' });
  }
  const token = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')?.[1];
  if (!token) return res.status(401).json({ error: 'Silakan masuk dengan Google terlebih dahulu.' });
  try {
    req.firebaseUser = await firebaseAdminAuth.verifyIdToken(token);
    return next();
  } catch {
    return res.status(401).json({ error: 'Sesi Google tidak valid atau sudah kedaluwarsa. Masuk kembali.' });
  }
}

function historyCollection(uid) {
  return firebaseDb.collection('users').doc(uid).collection('history');
}

function youtubeIntegrationRef(uid) {
  return firebaseDb.collection('users').doc(uid).collection('integrations').doc('youtube');
}

function youtubeOAuthConfig() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const encryptionKey = process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY || '';
  if (!clientId || !clientSecret || !/^[a-f\d]{64}$/i.test(encryptionKey)) return null;
  return { clientId, clientSecret, encryptionKey: Buffer.from(encryptionKey, 'hex') };
}

function youtubeSeoAIConfig() {
  // GEMINI_YOUTUBE_API_KEY adalah nama utama; alias ini menjaga deployment
  // yang sudah terlanjur menyimpan secret dengan nama singkat tetap aktif.
  const apiKey = String(process.env.GEMINI_YOUTUBE_API_KEY || process.env.GEMINI_YOUTUBE_KEY || '').trim();
  const model = String(process.env.GEMINI_YOUTUBE_MODEL || 'gemini-3.8-flash').trim();
  if (!apiKey || !model) return null;
  return { apiKey, model };
}

function parseSeoMetadata(value) {
  const cleaned = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('AI SEO mengembalikan format yang tidak dikenali. Coba lagi.');
  }
}

function encryptYoutubeRefreshToken(token, encryptionKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptYoutubeRefreshToken(value, encryptionKey) {
  const [version, ivValue, tagValue, encryptedValue] = String(value || '').split(':');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) throw new Error('Kredensial YouTube tidak valid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivValue, 'base64'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64')), decipher.final()]).toString('utf8');
}

async function youtubeTokenRequest(parameters) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(parameters),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Permintaan token YouTube gagal.');
    error.oauthError = data.error;
    throw error;
  }
  return data;
}

function historyFailureMessage(error, action) {
  const message = String(error?.message || '');
  if (/API has not been used|firestore\.googleapis\.com|SERVICE_DISABLED|Cloud Firestore API.*disabled/i.test(message)) {
    return 'Cloud Firestore API belum aktif. Aktifkan Cloud Firestore API di Google Cloud Console, lalu buat database Cloud Firestore di Firebase Console.';
  }
  if (/database.*(not found|does not exist)|NOT_FOUND.*database/i.test(message)) {
    return 'Database Cloud Firestore belum dibuat. Buat database di Firebase Console untuk mengaktifkan riwayat.';
  }
  if (/PERMISSION_DENIED|permission denied|insufficient permission/i.test(message)) {
    return 'Service account Firebase belum memiliki izin Firestore. Periksa akses IAM project Firebase.';
  }
  return `Riwayat gagal ${action} dari Firestore.`;
}

const TTS_VOICES = new Set(['Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Aoede', 'Autonoe', 'Callirrhoe', 'Charon', 'Despina', 'Enceladus', 'Erinome', 'Fenrir', 'Gacrux', 'Iapetus', 'Kore', 'Laomedeia', 'Leda', 'Orus', 'Puck', 'Pulcherrima', 'Rasalgethi', 'Sadachbia', 'Sadaltager', 'Schedar', 'Sulafat', 'Umbriel', 'Vindemiatrix', 'Zephyr', 'Zubenelgenubi']);

function requireKey(res) {
  if (!process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY_2 && !process.env.GEMINI_API_KEY_3) {
    res.status(503).json({ error: 'GEMINI_API_KEY belum diatur di environment variable server.' });
    return false;
  }
  return true;
}
function requireTtsKey(res) {
  if (!process.env.GEMINI_TTS_API_KEY) {
    res.status(503).json({ error: 'GEMINI_TTS_API_KEY belum diatur di environment variable server.' });
    return false;
  }
  return true;
}
function configuredGeminiKeys() {
  return [...new Set([process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(Boolean))];
}
function geminiKeysInRotation() {
  const keys = configuredGeminiKeys();
  if (!keys.length) return [];
  const start = nextGeminiKeyIndex % keys.length;
  const rotated = [...keys.slice(start), ...keys.slice(0, start)];
  const now = Date.now();
  return rotated.filter(key => (geminiKeyCooldowns.get(key) || 0) <= now);
}
function rotateGeminiKeyAfter(apiKey) {
  const keys = configuredGeminiKeys();
  const index = keys.indexOf(apiKey);
  if (index >= 0) nextGeminiKeyIndex = (index + 1) % keys.length;
}
function geminiKeyWaitMessage() {
  const keys = configuredGeminiKeys();
  const earliest = Math.min(...keys.map(key => geminiKeyCooldowns.get(key) || Date.now()));
  const seconds = Math.max(1, Math.ceil((earliest - Date.now()) / 1000));
  return `Semua Gemini API key sedang dibatasi kuota. Coba lagi sekitar ${seconds} detik.`;
}
function isGeminiQuotaError(status, message) {
  return status === 429 || /\b429\b|quota|resource exhausted|rate.?limit|too many requests/i.test(message || '');
}
function geminiQuotaCooldownMs(data, message) {
  const retryDelay = data?.error?.details?.find(detail => String(detail['@type'] || '').includes('RetryInfo'))?.retryDelay;
  const seconds = String(retryDelay || message || '').match(/(\d+(?:\.\d+)?)s\b/i)?.[1];
  if (seconds) return Math.max(1000, Math.ceil(Number(seconds) * 1000));
  if (/per[ _-]?day|daily/i.test(message || '')) return 24 * 60 * 60 * 1000;
  return GEMINI_KEY_COOLDOWN_MS;
}
function coolDownGeminiKey(apiKey, data, message) {
  geminiKeyCooldowns.set(apiKey, Date.now() + geminiQuotaCooldownMs(data, message));
  rotateGeminiKeyAfter(apiKey);
}
function isGeminiKeyAuthError(status, message) {
  return [400, 401, 403].includes(Number(status)) && /api.?key.*(invalid|not valid|expired)|unauthenticated|permission denied|access denied|forbidden|not authorized/i.test(message || '');
}
function isGeminiRetryableError(status, message) {
  return isGeminiQuotaError(status, message) || isGeminiKeyAuthError(status, message) ||
    [408, 425, 500, 502, 503, 504].includes(Number(status)) ||
    /high demand|overloaded|temporarily unavailable|unavailable|timeout|fetch failed|network error|ECONNRESET|ECONNREFUSED/i.test(message || '');
}
function coolDownGeminiKeyAfterFailure(apiKey, error) {
  if (isGeminiQuotaError(error.status, error.message)) {
    coolDownGeminiKey(apiKey, error.responseData, error.message);
    return;
  }
  const retryDelay = error.responseData?.error?.details?.find(detail => String(detail['@type'] || '').includes('RetryInfo'))?.retryDelay;
  const seconds = String(retryDelay || error.message || '').match(/(\d+(?:\.\d+)?)s\b/i)?.[1];
  const cooldownMs = isGeminiKeyAuthError(error.status, error.message)
    ? 60 * 60 * 1000
    : seconds ? Math.max(1000, Math.min(60000, Math.ceil(Number(seconds) * 1000))) : 15000;
  geminiKeyCooldowns.set(apiKey, Date.now() + cooldownMs);
  rotateGeminiKeyAfter(apiKey);
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function geminiRequest(model, body, fixedKey = null) {
  const models = [model || 'gemini-3.8-flash'];
  let lastError;
  while (true) {
    const keys = fixedKey ? [fixedKey] : geminiKeysInRotation();
    if (!keys.length) {
      const waits = configuredGeminiKeys().map(key => (geminiKeyCooldowns.get(key) || Date.now()) - Date.now()).filter(wait => wait > 0);
      await sleep(Math.max(250, Math.min(...waits, 30000)));
      continue;
    }
    for (const apiKey of keys) {
      let keyQuotaExhausted = false;
      for (const activeModel of models) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          let r;
          try {
            r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
            });
          } catch (error) {
            lastError = new Error(error.name === 'TimeoutError' ? 'Gemini request timeout setelah 30 detik.' : `Gemini request gagal: ${error.message}`);
            lastError.status = 503;
            if (attempt === 1) { coolDownGeminiKeyAfterFailure(apiKey, lastError); break; }
            await sleep(1200 * (attempt + 1));
            continue;
          }
          const data = await r.json().catch(() => ({}));
          if (r.ok) {
            if (!fixedKey) rotateGeminiKeyAfter(apiKey);
            return data;
          }
          lastError = new Error(data?.error?.message || `Gemini API error ${r.status}`);
          lastError.status = r.status;
          lastError.responseData = data;
          if (isGeminiQuotaError(r.status, lastError.message)) {
            coolDownGeminiKeyAfterFailure(apiKey, lastError);
            keyQuotaExhausted = true;
            break;
          }
          const retryable = /high demand|overloaded|temporarily unavailable|unavailable/i.test(lastError.message) || [500, 502, 503, 504].includes(r.status);
          if (!retryable) {
            if (!isGeminiKeyAuthError(r.status, lastError.message)) throw lastError;
            coolDownGeminiKeyAfterFailure(apiKey, lastError);
            keyQuotaExhausted = true;
            break;
          }
          if (attempt === 1) coolDownGeminiKeyAfterFailure(apiKey, lastError);
          if (attempt === 1) break;
          await sleep(1200 * (attempt + 1));
        }
        if (keyQuotaExhausted) break;
      }
      if (!fixedKey) rotateGeminiKeyAfter(apiKey);
    }
    if (fixedKey) throw lastError || new Error('Gemini API tidak merespons.');
    await sleep(500);
  }
}
async function uploadToGemini(filePath, mimeType, apiKey) {
  const stat = await fs.stat(filePath);
  let start;
  try {
    start = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(stat.size),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ file: { display_name: path.basename(filePath) } })
    });
  } catch (error) {
    error.status = 503;
    throw error;
  }
  if (!start.ok) {
    const error = new Error(`Gemini upload start failed: ${start.status} ${await start.text()}`);
    error.status = start.status;
    throw error;
  }
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini tidak mengembalikan upload URL.');
  const bytes = await fs.readFile(filePath);
  let finish;
  try {
    finish = await fetch(uploadUrl, {
      method: 'POST', headers: { 'Content-Length': String(bytes.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: bytes
    });
  } catch (error) {
    error.status = 503;
    throw error;
  }
  const fileInfo = await finish.json().catch(() => ({}));
  if (!finish.ok) {
    const error = new Error(fileInfo?.error?.message || `Gemini upload failed: ${finish.status}`);
    error.status = finish.status;
    error.responseData = fileInfo;
    throw error;
  }
  return fileInfo.file;
}
function jsonPart(text) {
  const raw = String(text || '').replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; }
}
function srtTime(seconds) { const ms = Math.max(0, Math.round(Number(seconds) * 1000)); const h = Math.floor(ms / 3600000); const m = Math.floor((ms % 3600000) / 60000); const s = Math.floor((ms % 60000) / 1000); const x = ms % 1000; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(x).padStart(3,'0')}`; }
function toSrt(segments) { return segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${String(s.text || '').trim()}\n`).join('\n'); }
function assColor(value) {
  const hex = /^#[0-9a-f]{6}$/i.test(value || '') ? value.slice(1) : 'FFFFFF';
  const r = hex.slice(0, 2), g = hex.slice(2, 4), b = hex.slice(4, 6);
  return `&H00${b}${g}${r}`;
}
function subtitleStyle(settings) {
  const allowedFonts = new Set(['DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Liberation Sans']);
  const font = allowedFonts.has(settings.fontFamily) ? settings.fontFamily : 'DejaVu Sans';
  const color = assColor(settings.color === 'gradient' ? '#8b5cf6' : settings.color);
  const size = Math.min(33, Math.max(8, Number(settings.fontSize) || 28));
  const align = settings.position === 'top' ? 6 : settings.position === 'middle' ? 10 : 2;
  const margin = settings.position === 'top' ? 36 : settings.position === 'middle' ? 20 : 42;
  const templates = {
    pill: `BorderStyle=4,Outline=0,Shadow=0,BackColour=&H99000000`,
    neon: `BorderStyle=1,Outline=2,Shadow=0,BackColour=&H66000000`,
    minimal: `BorderStyle=1,Outline=0,Shadow=0,BackColour=&H00000000`,
    outline: `BorderStyle=1,Outline=2,Shadow=0,BackColour=&H00000000`,
    karaoke: `BorderStyle=4,Outline=1,Shadow=0,BackColour=&H88000000`,
    bubble: `BorderStyle=3,Outline=0,Shadow=0,BackColour=&H00FFFFFF`,
    shadow: `BorderStyle=1,Outline=0,Shadow=3,BackColour=&H00000000`,
    gradient: `BorderStyle=4,Outline=1,Shadow=0,BackColour=&H66000000`
  };
  const outlineColor = settings.template === 'neon' ? assColor('#38e8ff') : '&H00000000';
  return `FontName=${font},FontSize=${size},PrimaryColour=${color},OutlineColour=${outlineColor},${templates[settings.template] || templates.pill},Alignment=${align},MarginV=${margin}`;
}
async function cleanup(...files) { await Promise.all(files.filter(Boolean).map(f => fs.rm(f, { force: true }).catch(() => {}))); }
function responseText(data) { return data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || ''; }

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  service: 'videoteks',
  provider: 'gemini',
  geminiYoutubeConfigured: Boolean(youtubeSeoAIConfig()),
  youtubeOAuthConfigured: Boolean(youtubeOAuthConfig())
}));

app.post('/api/transcribe', requireFirebaseUser, upload.single('video'), async (req, res) => {
  if (!requireKey(res)) return;
  if (!req.file) return res.status(400).json({ error: 'File video wajib dipilih.' });
  const audio = `${req.file.path}.mp3`;
  const requestStartedAt = performance.now();
  try {
    const extractionStartedAt = performance.now();
    await exec('ffmpeg', ['-y', '-i', req.file.path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', audio]);
    const extractionMs = Math.round(performance.now() - extractionStartedAt);
    const audioStats = await fs.stat(audio);
    const useInlineAudio = audioStats.size <= INLINE_AUDIO_MAX_BYTES;
    const inlineAudio = useInlineAudio ? await fs.readFile(audio, 'base64') : null;
    console.info(`[transcribe] audio ready mode=${useInlineAudio ? 'inline' : 'files'} bytes=${audioStats.size} extractMs=${extractionMs}`);
    const prompt = `Transkripsikan audio ini menjadi subtitle. Kembalikan JSON valid saja dengan bentuk {"segments":[{"start":0.0,"end":2.5,"text":"..."}]}. Gunakan waktu dalam detik, urutkan dari awal sampai akhir, pecah kalimat menjadi segmen pendek yang nyaman dibaca, dan tulis teks persis sesuai ucapan dalam bahasa aslinya. Jangan tambahkan markdown atau komentar.`;
    while (true) {
      const keys = geminiKeysInRotation();
      if (!keys.length) {
        const waits = configuredGeminiKeys().map(key => (geminiKeyCooldowns.get(key) || Date.now()) - Date.now()).filter(wait => wait > 0);
        await sleep(Math.max(250, Math.min(...waits, 30000)));
        continue;
      }
      for (const apiKey of keys) {
        const keySlot = configuredGeminiKeys().indexOf(apiKey) + 1;
        const keyCount = configuredGeminiKeys().length;
        try {
          let audioPart;
          let uploadMs = 0;
          if (useInlineAudio) {
            audioPart = { inlineData: { mimeType: 'audio/mpeg', data: inlineAudio } };
          } else {
            const uploadStartedAt = performance.now();
            const file = await uploadToGemini(audio, 'audio/mpeg', apiKey);
            uploadMs = Math.round(performance.now() - uploadStartedAt);
            audioPart = { fileData: { fileUri: file.uri, mimeType: file.mimeType || 'audio/mpeg' } };
          }
          const inferenceStartedAt = performance.now();
          const data = await geminiRequest(MODEL, { contents: [{ parts: [{ text: prompt }, audioPart] }], generationConfig: { responseMimeType: 'application/json' } }, apiKey);
          console.info(`[transcribe] complete mode=${useInlineAudio ? 'inline' : 'files'} bytes=${audioStats.size} extractMs=${extractionMs} uploadMs=${uploadMs} generateMs=${Math.round(performance.now() - inferenceStartedAt)} totalMs=${Math.round(performance.now() - requestStartedAt)}`);
          const parsed = jsonPart(responseText(data));
          const segments = (parsed?.segments || []).map(s => ({ start: Number(s.start) || 0, end: Number(s.end) || (Number(s.start) + 2), text: String(s.text || '').trim() })).filter(s => s.text);
          rotateGeminiKeyAfter(apiKey);
          const text = segments.map(s => s.text).join('\n');
          let historyId = null;
          let historyErrorMessage = null;
          try {
            const historyDoc = await historyCollection(req.firebaseUser.uid).add({
              type: 'video-transcription',
              title: 'Transkripsi video',
              fileName: String(req.file.originalname || 'video').replace(/[\u0000-\u001f]/g, '').slice(0, 180),
              text,
              segments,
              settings: {},
              createdAt: Date.now(),
              updatedAt: Date.now()
            });
            historyId = historyDoc.id;
          } catch (historyError) {
            historyErrorMessage = historyFailureMessage(historyError, 'disimpan');
            console.warn('[history] transkripsi berhasil, tetapi riwayat gagal disimpan:', historyError.message);
          }
          res.json({ text, segments, historyId, historySaved: Boolean(historyId), historyError: historyErrorMessage });
          return;
        } catch (error) {
          if (!isGeminiRetryableError(error.status, error.message)) {
            rotateGeminiKeyAfter(apiKey);
            throw error;
          }
          coolDownGeminiKeyAfterFailure(apiKey, error);
          const waitSeconds = Math.max(1, Math.ceil(((geminiKeyCooldowns.get(apiKey) || Date.now()) - Date.now()) / 1000));
          console.warn(`[transcribe] key_slot=${keySlot}/${keyCount} temporarily unavailable; rotating, retry_in=${waitSeconds}s status=${error.status || 'network'}`);
        }
      }
    }
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
  finally { await cleanup(req.file.path, audio); }
});

app.post('/api/translate', requireFirebaseUser, async (req, res) => {
  if (!requireKey(res)) return;
  const { text, target = 'Indonesian' } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Teks wajib diisi.' });
  try {
    const prompt = `Terjemahkan teks subtitle berikut ke ${target}. Pertahankan jumlah baris dan urutan baris. Kembalikan hanya hasil terjemahan tanpa komentar.\n\n${text}`;
    const data = await geminiRequest(MODEL, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 } });
    const translatedText = responseText(data).trim();
    let historyId = null;
    let historySaved = false;
    let historyError = null;
    try {
      const requestedHistoryId = String(req.body.historyId || '');
      if (requestedHistoryId) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestedHistoryId)) throw new Error('ID riwayat tidak valid.');
        const ref = historyCollection(req.firebaseUser.uid).doc(requestedHistoryId);
        const document = await ref.get();
        if (!document.exists) throw new Error('Riwayat video tidak ditemukan.');
        await ref.update({ translatedText: translatedText.slice(0, 100000), translationTarget: String(target).slice(0, 64), updatedAt: Date.now() });
        historyId = requestedHistoryId;
      } else {
        const historyDoc = await historyCollection(req.firebaseUser.uid).add({
          type: 'video-translation',
          title: 'Terjemahan video',
          sourceText: String(text).slice(0, 100000),
          translatedText: translatedText.slice(0, 100000),
          translationTarget: String(target).slice(0, 64),
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
        historyId = historyDoc.id;
      }
      historySaved = true;
    } catch (historyWriteError) {
      historyError = historyFailureMessage(historyWriteError, 'disimpan');
      console.warn('[history] terjemahan berhasil, tetapi riwayat gagal disimpan:', historyWriteError.message);
    }
    res.json({ text: translatedText, historyId, historySaved, historyError });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/export', requireFirebaseUser, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File video wajib dipilih.' });
  const id = crypto.randomUUID(); const srt = path.join(os.tmpdir(), `videoteks-${id}.srt`); const out = path.join(os.tmpdir(), `videoteks-${id}.mp4`);
  try {
    const segments = JSON.parse(req.body.segments || '[]');
    const settings = { color: req.body.color, template: req.body.template, fontSize: req.body.fontSize, position: req.body.position, fontFamily: req.body.fontFamily, format: req.body.format || 'auto' };
    if (!segments.length) return res.status(400).json({ error: 'Belum ada subtitle untuk diekspor.' });
    await fs.writeFile(srt, toSrt(segments), 'utf8');
    const style = subtitleStyle(settings);
    const outputSize = settings.format === 'short' ? '720x1280' : settings.format === 'square' ? '720x720' : settings.format === 'landscape' ? '1280x720' : 'source size';
    const shape = settings.format === 'short' ? 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,' : settings.format === 'square' ? 'scale=720:720:force_original_aspect_ratio=increase,crop=720:720,' : settings.format === 'landscape' ? 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,' : '';
    const renderStartedAt = performance.now();
    const ffmpegArgs = ['-y', '-i', req.file.path, '-vf', `${shape}subtitles=${srt}:force_style='${style}'`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25'];
    let audioMode = 'copy';
    try {
      await exec('ffmpeg', [...ffmpegArgs, '-c:a', 'copy', out]);
    } catch (error) {
      const details = `${error.message}\n${error.stderr || ''}`;
      if (!/could not find tag for codec|not currently supported in container|could not write header|codec .* incompatible with output/i.test(details)) throw error;
      await cleanup(out);
      audioMode = 'aac-fallback';
      await exec('ffmpeg', [...ffmpegArgs, '-c:a', 'aac', '-b:a', '128k', out]);
    }
    const outputStats = await fs.stat(out);
    console.info(`[export] complete format=${settings.format} output=${outputSize} audio=${audioMode} inputBytes=${req.file.size} outputBytes=${outputStats.size} renderMs=${Math.round(performance.now() - renderStartedAt)}`);
    res.download(out, 'videoteks-subtitle.mp4', async () => { await cleanup(req.file.path, srt, out); });
  } catch (e) { console.error(e); await cleanup(req.file.path, srt, out); res.status(500).json({ error: e.message }); }
});

app.post('/api/replace-audio', requireFirebaseUser, upload.fields([{ name: 'video', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), async (req, res) => {
  const videoFile = req.files?.video?.[0];
  const audioFile = req.files?.audio?.[0];
  if (!videoFile || !audioFile) {
    await cleanup(videoFile?.path, audioFile?.path);
    return res.status(400).json({ error: 'Pilih video dan file MP3 terlebih dahulu.' });
  }
  const out = path.join(os.tmpdir(), `videoteks-audio-${crypto.randomUUID()}.mp4`);
  try {
    const { stdout: probeText } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration:format=duration', '-of', 'json', videoFile.path]);
    const probe = JSON.parse(probeText || '{}');
    const durations = [probe.streams?.[0]?.duration, probe.format?.duration].map(Number).filter(value => Number.isFinite(value) && value > 0);
    const duration = durations[0];
    if (!duration) throw new Error('Durasi video tidak dapat dibaca.');

    const { stdout: audioProbeText } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration:format=duration', '-of', 'json', audioFile.path]);
    const audioProbe = JSON.parse(audioProbeText || '{}');
    const audioDurations = [audioProbe.streams?.[0]?.duration, audioProbe.format?.duration].map(Number).filter(value => Number.isFinite(value) && value > 0);
    const audioDuration = audioDurations[0];
    if (!audioDuration) throw new Error('Durasi file audio tidak dapat dibaca.');

    const requestedMode = req.body.audioMode;
    const audioMode = ['auto', 'manual', 'original'].includes(requestedMode) ? requestedMode : (req.body.fitAudio === 'false' ? 'original' : 'auto');
    const requestedManualSpeed = Number(req.body.manualSpeed);
    const manualSpeed = Number.isFinite(requestedManualSpeed) ? Math.min(2, Math.max(0.5, requestedManualSpeed)) : 1;
    const speed = audioMode === 'manual' ? manualSpeed : audioDuration / duration;
    const atempoFilters = [];
    if (audioMode !== 'original') {
      let remainingSpeed = speed;
      while (remainingSpeed > 2) { atempoFilters.push('atempo=2'); remainingSpeed /= 2; }
      while (remainingSpeed < 0.5) { atempoFilters.push('atempo=0.5'); remainingSpeed /= 0.5; }
      atempoFilters.push(`atempo=${remainingSpeed.toFixed(6)}`);
    }

    const inputArgs = ['-y', '-i', videoFile.path];
    if (audioMode === 'original') inputArgs.push('-stream_loop', '-1');
    inputArgs.push('-i', audioFile.path);
    const commonArgs = [...inputArgs, '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '0'];
    if (audioMode !== 'original') commonArgs.push('-af', `${atempoFilters.join(',')},apad`);
    commonArgs.push('-t', duration.toFixed(3), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
    let videoMode = 'copy';
    try {
      await exec('ffmpeg', [...commonArgs, '-c:v', 'copy', out]);
    } catch {
      await cleanup(out);
      videoMode = 'h264-fallback';
      await exec('ffmpeg', [...commonArgs, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25', '-pix_fmt', 'yuv420p', out]);
    }
    const outputStats = await fs.stat(out);
    console.info(`[replace-audio] complete videoMode=${videoMode} audioMode=${audioMode} speed=${audioMode === 'original' ? 'original' : speed.toFixed(3)} videoDuration=${duration.toFixed(2)} audioDuration=${audioDuration.toFixed(2)} inputVideoBytes=${videoFile.size} inputAudioBytes=${audioFile.size} outputBytes=${outputStats.size}`);
    let historyId = null;
    try {
      const historyDoc = await historyCollection(req.firebaseUser.uid).add({
        type: 'audio-replace',
        title: 'Ganti audio',
        fileName: String(videoFile.originalname || 'video').replace(/[\u0000-\u001f]/g, '').slice(0, 180),
        audioFileName: String(audioFile.originalname || 'audio').replace(/[\u0000-\u001f]/g, '').slice(0, 180),
        audioMode,
        speed: audioMode === 'original' ? null : Number(speed.toFixed(3)),
        videoDuration: Number(duration.toFixed(2)),
        audioDuration: Number(audioDuration.toFixed(2)),
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      historyId = historyDoc.id;
    } catch (historyError) {
      console.warn('[history] ganti audio berhasil, tetapi riwayat gagal disimpan:', historyError.message);
    }
    res.set('X-History-Saved', String(Boolean(historyId)));
    if (historyId) res.set('X-History-Id', historyId);
    res.download(out, 'video-audio-baru.mp4', async () => { await cleanup(videoFile.path, audioFile.path, out); });
  } catch (error) {
    console.error(error);
    await cleanup(videoFile.path, audioFile.path, out);
    res.status(500).json({ error: error.message || 'Video gagal diproses.' });
  }
});

app.get('/api/history', requireFirebaseUser, async (req, res) => {
  try {
    const snapshot = await historyCollection(req.firebaseUser.uid).orderBy('createdAt', 'desc').limit(100).get();
    res.json({ items: snapshot.docs.map((document) => ({ id: document.id, ...document.data() })) });
  } catch (error) {
    console.error('[history] gagal memuat:', error.message);
    res.status(500).json({ error: historyFailureMessage(error, 'dimuat') });
  }
});

app.patch('/api/history/:id', requireFirebaseUser, async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return res.status(400).json({ error: 'ID riwayat tidak valid.' });
  try {
    const ref = historyCollection(req.firebaseUser.uid).doc(id);
    const document = await ref.get();
    if (!document.exists) return res.status(404).json({ error: 'Riwayat tidak ditemukan.' });
    const rawSegments = Array.isArray(req.body?.segments) ? req.body.segments : [];
    if (rawSegments.length > 3000) return res.status(413).json({ error: 'Jumlah segmen terlalu besar untuk disimpan.' });
    const segments = rawSegments.map((segment) => ({
      start: Number.isFinite(Number(segment.start)) ? Number(segment.start) : 0,
      end: Number.isFinite(Number(segment.end)) ? Number(segment.end) : 0,
      text: String(segment.text || '').slice(0, 2000)
    }));
    const settings = req.body?.settings && typeof req.body.settings === 'object' ? {
      color: String(req.body.settings.color || '').slice(0, 32),
      template: String(req.body.settings.template || '').slice(0, 32),
      fontSize: Number(req.body.settings.fontSize) || 28,
      position: String(req.body.settings.position || '').slice(0, 16),
      fontFamily: String(req.body.settings.fontFamily || '').slice(0, 64),
      outputFormat: String(req.body.settings.outputFormat || '').slice(0, 24)
    } : document.data().settings || {};
    await ref.update({
      text: String(req.body?.text || '').slice(0, 200000),
      segments,
      settings,
      updatedAt: Date.now()
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('[history] gagal memperbarui:', error.message);
    res.status(500).json({ error: 'Perubahan riwayat gagal disimpan.' });
  }
});

app.delete('/api/history/:id', requireFirebaseUser, async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return res.status(400).json({ error: 'ID riwayat tidak valid.' });
  try {
    const ref = historyCollection(req.firebaseUser.uid).doc(id);
    const document = await ref.get();
    if (!document.exists) return res.status(404).json({ error: 'Riwayat tidak ditemukan.' });
    await ref.delete();
    res.status(204).end();
  } catch (error) {
    console.error('[history] gagal menghapus:', error.message);
    res.status(500).json({ error: 'Riwayat gagal dihapus.' });
  }
});

app.get('/api/youtube/status', requireFirebaseUser, async (req, res) => {
  const config = youtubeOAuthConfig();
  if (!config) return res.status(503).json({ error: 'Integrasi YouTube belum dikonfigurasi di server.' });
  try {
    const snapshot = await youtubeIntegrationRef(req.firebaseUser.uid).get();
    res.json({ configured: true, connected: Boolean(snapshot.data()?.refreshTokenEncrypted), clientId: config.clientId });
  } catch (error) {
    console.error('[youtube] gagal membaca status koneksi:', error.message);
    res.status(500).json({ error: 'Status koneksi YouTube gagal dimuat.' });
  }
});

app.get('/api/youtube/seo-status', requireFirebaseUser, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const config = youtubeSeoAIConfig();
  res.json({ configured: Boolean(config), model: config?.model || null });
});

app.post('/api/youtube/seo-metadata', requireFirebaseUser, async (req, res) => {
  const config = youtubeSeoAIConfig();
  if (!config) return res.status(503).json({ error: 'AI SEO Gemini YouTube belum dikonfigurasi. Isi GEMINI_YOUTUBE_API_KEY di server.' });
  const captions = String(req.body?.captions || '').trim().slice(0, 12000);
  const language = String(req.body?.language || '').trim().slice(0, 80);
  const topic = String(req.body?.topic || '').trim().slice(0, 240);
  if (!captions && !topic) return res.status(400).json({ error: 'Masukkan topik atau teruskan subtitle agar AI SEO memiliki konteks.' });
  const prompt = [
    'Buat metadata YouTube yang menarik dan ramah pencarian berdasarkan konteks yang diberikan.',
    'Jangan mengarang fakta yang tidak ada dalam konteks. Hindari clickbait menyesatkan.',
    'Kembalikan hanya JSON valid dengan tiga properti: {"title":"...","description":"...","tags":["..."]}.',
    'Judul maksimal 100 karakter. Deskripsi maksimal 5000 karakter, tulis ringkas, relevan, natural, dan boleh menyertakan tagar seperlunya.',
    'Buat 3 sampai 15 tag YouTube yang relevan, singkat, tanpa tanda #, dan jangan mengulang tag yang sama.',
    language ? `Bahasa target subtitle/video: ${language}. Tulis metadata dalam bahasa tersebut.` : 'Gunakan bahasa yang paling sesuai dengan konteks.',
    topic ? `Topik/kata kunci tambahan dari pengguna: ${topic}` : '',
    captions ? `Subtitle/konteks video:\n${captions}` : ''
  ].filter(Boolean).join('\n\n');
  try {
    const result = await geminiRequest(config.model, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.5, responseMimeType: 'application/json' }
    }, config.apiKey);
    const text = result?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('');
    const metadata = parseSeoMetadata(text);
    const title = String(metadata?.title || '').trim().slice(0, 100);
    const description = String(metadata?.description || '').trim().slice(0, 5000);
    const tags = Array.isArray(metadata?.tags)
      ? [...new Set(metadata.tags.map((tag) => String(tag || '').trim()).filter(Boolean))].slice(0, 30)
      : [];
    const tagsWithinLimit = [];
    let tagsLength = 0;
    for (const tag of tags) {
      const nextLength = tagsLength + tag.length + (tagsWithinLimit.length ? 1 : 0);
      if (nextLength > 500) break;
      tagsWithinLimit.push(tag);
      tagsLength = nextLength;
    }
    if (!title || !description) return res.status(502).json({ error: 'Gemini tidak mengembalikan judul dan deskripsi. Coba lagi.' });
    res.set('Cache-Control', 'no-store');
    res.json({ title, description, tags: tagsWithinLimit });
  } catch (error) {
    console.warn('[youtube-seo] Gemini request failed:', error.message || error.name || 'Error');
    res.status(502).json({ error: 'Gemini tidak dapat membuat judul dan deskripsi. Periksa API key, model, kuota, lalu coba lagi.' });
  }
});

/*
 * Metadata SEO YouTube menggunakan Gemini khusus dengan API key terpisah.
 * Route di atas sengaja tidak memakai provider OpenAI/SEO lama.
 */
/* legacy block removed */

app.post('/api/youtube/connect', requireFirebaseUser, async (req, res) => {
  const config = youtubeOAuthConfig();
  if (!config) return res.status(503).json({ error: 'Integrasi YouTube belum dikonfigurasi di server.' });
  const origin = req.get('origin');
  if (!origin || !allowedOrigins.has(origin) || req.get('X-Requested-With') !== 'XmlHttpRequest') {
    return res.status(403).json({ error: 'Permintaan OAuth YouTube tidak valid.' });
  }
  if (YOUTUBE_REDIRECT_URI !== origin) {
    return res.status(500).json({ error: 'YOUTUBE_REDIRECT_URI harus sama persis dengan origin aplikasi yang meminta OAuth.' });
  }
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  if (!code || code.length > 4096) return res.status(400).json({ error: 'Kode otorisasi YouTube tidak valid.' });
  try {
    const tokens = await youtubeTokenRequest({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: YOUTUBE_REDIRECT_URI,
      grant_type: 'authorization_code'
    });
    const grantedScopes = String(tokens.scope || '').split(/\s+/);
    if (!tokens.access_token || (tokens.scope && !grantedScopes.includes('https://www.googleapis.com/auth/youtube.upload'))) {
      return res.status(403).json({ error: 'Google tidak memberikan izin unggah YouTube yang diperlukan.' });
    }
    const ref = youtubeIntegrationRef(req.firebaseUser.uid);
    const existing = await ref.get();
    let refreshToken = tokens.refresh_token;
    if (!refreshToken && existing.data()?.refreshTokenEncrypted) {
      refreshToken = decryptYoutubeRefreshToken(existing.data().refreshTokenEncrypted, config.encryptionKey);
    }
    if (!refreshToken) {
      return res.status(409).json({ error: 'Google belum memberikan izin akses jangka panjang. Lepas akses VideoTeks di pengaturan Akun Google lalu hubungkan kembali.' });
    }
    await ref.set({
      refreshTokenEncrypted: encryptYoutubeRefreshToken(refreshToken, config.encryptionKey),
      scopes: grantedScopes,
      connectedAt: existing.data()?.connectedAt || Date.now(),
      updatedAt: Date.now()
    }, { merge: true });
    res.json({ connected: true, accessToken: tokens.access_token });
  } catch (error) {
    const oauthError = error.oauthError;
    console.error('[youtube] gagal menyambungkan akun:', oauthError || error.message);
    if (oauthError === 'invalid_client') {
      return res.status(502).json({ error: 'Kredensial OAuth Google tidak valid. Periksa YOUTUBE_CLIENT_ID dan YOUTUBE_CLIENT_SECRET dari OAuth Web Client yang sama di Render.' });
    }
    res.status(502).json({ error: 'Akun YouTube gagal disambungkan. Coba ulangi persetujuan akun.' });
  }
});

app.get('/api/youtube/access-token', requireFirebaseUser, async (req, res) => {
  const config = youtubeOAuthConfig();
  if (!config) return res.status(503).json({ error: 'Integrasi YouTube belum dikonfigurasi di server.' });
  const ref = youtubeIntegrationRef(req.firebaseUser.uid);
  try {
    const snapshot = await ref.get();
    const encryptedToken = snapshot.data()?.refreshTokenEncrypted;
    if (!encryptedToken) return res.status(404).json({ error: 'Akun YouTube belum terhubung.', reconnect: true });
    const refreshToken = decryptYoutubeRefreshToken(encryptedToken, config.encryptionKey);
    const tokens = await youtubeTokenRequest({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });
    if (!tokens.access_token) throw new Error('Google tidak mengembalikan access token.');
    const update = { lastRefreshedAt: Date.now() };
    if (tokens.refresh_token) update.refreshTokenEncrypted = encryptYoutubeRefreshToken(tokens.refresh_token, config.encryptionKey);
    await ref.set(update, { merge: true });
    res.set('Cache-Control', 'no-store');
    res.json({ accessToken: tokens.access_token, expiresIn: tokens.expires_in || 3600 });
  } catch (error) {
    if (error.oauthError === 'invalid_grant') {
      await ref.delete().catch(() => {});
      return res.status(401).json({ error: 'Izin YouTube sudah dicabut atau kedaluwarsa. Hubungkan akun kembali.', reconnect: true });
    }
    console.error('[youtube] gagal memperbarui token akses:', error.oauthError || error.message);
    res.status(502).json({ error: 'Akses YouTube sementara gagal diperbarui. Coba lagi.' });
  }
});

app.delete('/api/youtube/connection', requireFirebaseUser, async (req, res) => {
  const ref = youtubeIntegrationRef(req.firebaseUser.uid);
  try {
    const snapshot = await ref.get();
    const config = youtubeOAuthConfig();
    const encryptedToken = snapshot.data()?.refreshTokenEncrypted;
    if (config && encryptedToken) {
      try {
        const refreshToken = decryptYoutubeRefreshToken(encryptedToken, config.encryptionKey);
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(10000)
        });
      } catch (error) {
        console.warn('[youtube] pencabutan izin Google tidak berhasil; kredensial lokal tetap dihapus:', error.message);
      }
    }
    await ref.delete();
    res.json({ ok: true });
  } catch (error) {
    console.error('[youtube] gagal menghapus koneksi:', error.message);
    res.status(500).json({ error: 'Koneksi YouTube gagal dilepas.' });
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(process.cwd(), 'public', 'index.html')));

app.post('/api/generate-voice', requireFirebaseUser, async (req, res) => {
  if (!requireTtsKey(res)) return;
  const text = String(req.body?.text || '').trim();
  const voice = TTS_VOICES.has(req.body?.voice) ? req.body.voice : 'Kore';
  const style = String(req.body?.style || '').trim().slice(0, 240);
  if (!text) return res.status(400).json({ error: 'Teks untuk suara wajib diisi.' });
  if (text.length > 5000) return res.status(400).json({ error: 'Teks terlalu panjang. Maksimal 5.000 karakter per audio.' });
  try {
    const promptPart = { text };
    if (style) promptPart.speech_metadata = { style };
    const data = await geminiRequest(process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts', {
      contents: [{ role: 'user', parts: [promptPart] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { voice } }
      }
    }, process.env.GEMINI_TTS_API_KEY);
    const audioData = data?.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData?.data;
    if (!audioData) throw new Error('Gemini tidak mengembalikan data audio.');
    let historyId = null;
    try {
      const historyDoc = await historyCollection(req.firebaseUser.uid).add({
        type: 'ai-voice',
        title: 'Suara AI',
        inputText: text,
        voice,
        style,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      historyId = historyDoc.id;
    } catch (historyError) {
      console.warn('[history] suara AI berhasil, tetapi riwayat gagal disimpan:', historyError.message);
    }
    res.set('X-History-Saved', String(Boolean(historyId)));
    if (historyId) res.set('X-History-Id', historyId);
    res.set('Content-Type', 'audio/wav');
    res.set('Content-Disposition', 'attachment; filename="suara-ai-gemini.wav"');
    res.send(Buffer.from(audioData, 'base64'));
  } catch (error) {
    console.error('[generate-voice]', error);
    res.status(error.status === 429 ? 429 : 502).json({ error: error.message || 'Suara AI gagal dibuat.' });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`VideoTeks Gemini berjalan di port ${PORT}`));
