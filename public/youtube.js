import { authenticatedFetch, requireLogin } from './firebase-client.js';
import { loadYoutubeHandoff } from './youtube-handoff.js';

const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status';
await requireLogin();

// Fallback for Android/PWA webviews that swallow native page scrolling.
let touchStartX = 0;
let touchStartY = 0;
document.addEventListener('touchstart', (event) => {
  if (event.touches.length !== 1) return;
  touchStartX = event.touches[0].clientX;
  touchStartY = event.touches[0].clientY;
}, { passive: true });
document.addEventListener('touchmove', (event) => {
  if (event.touches.length !== 1) return;
  const touch = event.touches[0];
  const deltaX = touch.clientX - touchStartX;
  const deltaY = touchStartY - touch.clientY;
  if (Math.abs(deltaY) <= Math.abs(deltaX) || Math.abs(deltaY) < 1) return;
  const scroller = document.scrollingElement || document.documentElement;
  const before = scroller.scrollTop;
  const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.max(0, Math.min(maximum, before + deltaY));
  if (scroller.scrollTop !== before) event.preventDefault();
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
}, { passive: false });

const $ = (selector) => document.querySelector(selector);
const connectButton = $('#connectButton');
const disconnectButton = $('#disconnectButton');
const uploadButton = $('#uploadButton');
const fileInput = $('#videoFile');
const titleInput = $('#videoTitle');
const descriptionInput = $('#videoDescription');
const rightsCheck = $('#rightsCheck');
const statusNode = $('#status');
const progress = $('#progress');
const progressFill = $('#progressFill');
const successLink = $('#successLink');
const seoButton = $('#seoButton');
const seoTopic = $('#seoTopic');
const seoContentConsent = $('#seoContentConsent');
let codeClient = null;
let accessToken = null;
let selectedFile = null;
let uploading = false;
let seoBusy = false;
let seoAiConfigured = false;
let seoTags = [];
let seoGenerationPromise = null;
let sourceCaptions = '';
let sourceLanguage = '';
let loadingHandoff = false;
let authorizationTimer = null;

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.className = `status${isError ? ' error' : ''}`;
}

function updateControls() {
  connectButton.disabled = !codeClient || uploading;
  disconnectButton.hidden = !accessToken;
  uploadButton.disabled = uploading || seoBusy || !accessToken || !selectedFile || !titleInput.value.trim() || !rightsCheck.checked;
  fileInput.disabled = uploading || seoBusy;
  titleInput.disabled = uploading;
  descriptionInput.disabled = uploading;
  $('#privacyStatus').disabled = uploading;
  rightsCheck.disabled = uploading;
  seoContentConsent.disabled = uploading || seoBusy;
  // Tombol tetap aktif; jika AI belum siap, tampilkan error dari server saat ditekan.
  seoButton.disabled = uploading || seoBusy;
}

function displayBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function parseResponse(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function apiErrorMessage(text, statusCode) {
  const response = parseResponse(text);
  const message = response?.error || response?.error_description;
  if (message) return message;
  if (statusCode === 401) return 'Sesi YouTube perlu diperbarui. Hubungkan akun kembali, lalu ulangi unggahan.';
  if (statusCode === 403) return 'Akses unggah ditolak. Pastikan layanan unggah video diaktifkan untuk aplikasi ini.';
  return `Unggahan gagal (HTTP ${statusCode || 'tidak diketahui'}). Coba lagi.`;
}

function waitForIdentityLibrary(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve(window.google.accounts.oauth2);
    const script = $('#googleIdentityScript');
    const timeout = setTimeout(() => reject(new Error('Layanan akun tidak dapat dimuat. Periksa koneksi internet.')), timeoutMs);
    script?.addEventListener('load', () => {
      clearTimeout(timeout);
      if (window.google?.accounts?.oauth2) resolve(window.google.accounts.oauth2);
      else reject(new Error('Layanan akun tidak tersedia di browser ini.'));
    }, { once: true });
    script?.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('Gagal memuat layanan akun. Periksa koneksi internet.'));
    }, { once: true });
  });
}

async function apiRequest(url, options = {}) {
  const response = await authenticatedFetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Permintaan gagal (HTTP ${response.status}).`);
    error.status = response.status;
    error.reconnect = Boolean(data.reconnect);
    throw error;
  }
  return data;
}

function setConnected(token) {
  accessToken = token;
  $('#accountLabel').textContent = 'Terhubung otomatis';
  $('#accountHint').textContent = 'Akun YouTube tersimpan dengan aman. VideoTeks akan memulihkan akses saat Anda kembali.';
  setStatus('Akun YouTube siap. Pilih video dan lengkapi detail unggahan.');
  updateControls();
}

function setDisconnected(message = 'Akun YouTube belum terhubung.') {
  accessToken = null;
  $('#accountLabel').textContent = 'Belum terhubung';
  $('#accountHint').textContent = 'Hubungkan sekali untuk memulihkan akses otomatis saat Anda kembali.';
  setStatus(message);
  updateControls();
}

async function refreshAccessToken() {
  const data = await apiRequest('/api/youtube/access-token', { method: 'GET' });
  if (!data.accessToken) throw new Error('Server tidak mengembalikan akses YouTube.');
  return data.accessToken;
}

function clearAuthorizationTimer() {
  if (authorizationTimer) clearTimeout(authorizationTimer);
  authorizationTimer = null;
}

function createMultipartBody(file, metadata) {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '') || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const boundary = `videoteks${random}`;
  const mediaType = /^video\/[a-z0-9.+-]+$/i.test(file.type) ? file.type : 'application/octet-stream';
  const firstPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`;
  const lastPart = `\r\n--${boundary}--\r\n`;
  return new Blob([firstPart, file, lastPart], { type: `multipart/related; boundary=${boundary}` });
}

function uploadVideo(file, metadata, token) {
  return new Promise((resolve, reject) => {
    const body = createMultipartBody(file, metadata);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', UPLOAD_ENDPOINT, true);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', body.type);
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.min(99, Math.floor((event.loaded / event.total) * 100));
      progressFill.style.width = `${percent}%`;
      setStatus(`Mengunggah video… ${percent}% (${displayBytes(Math.min(event.loaded, body.size))} dari ${displayBytes(body.size)})`);
    });
    xhr.onload = () => {
      const response = parseResponse(xhr.responseText);
      if ((xhr.status === 200 || xhr.status === 201) && response?.id) {
        resolve(response);
        return;
      }
      const error = new Error(apiErrorMessage(xhr.responseText, xhr.status));
      error.status = xhr.status;
      reject(error);
    };
    xhr.onerror = () => reject(new Error('Koneksi terputus. Jika unggahan berhenti, pilih video dan mulai lagi.'));
    xhr.onabort = () => reject(new Error('Unggahan dibatalkan.'));
    xhr.send(body);
  });
}

async function handleAuthorizationCode(response) {
  clearAuthorizationTimer();
  connectButton.textContent = 'Menghubungkan…';
  if (response?.error || !response?.code) {
    connectButton.textContent = 'Hubungkan akun';
    setStatus(response?.error_description || response?.error || 'Persetujuan akun tidak berhasil.', true);
    updateControls();
    return;
  }
  try {
    setStatus('Menyimpan koneksi YouTube dengan aman…');
    const data = await apiRequest('/api/youtube/connect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XmlHttpRequest'
      },
      body: JSON.stringify({ code: response.code })
    });
    if (!data.accessToken) throw new Error('Server tidak mengembalikan akses YouTube.');
    setConnected(data.accessToken);
  } catch (error) {
    setDisconnected(error.message || 'Akun YouTube gagal disambungkan.');
    setStatus(error.message || 'Akun YouTube gagal disambungkan.', true);
  } finally {
    connectButton.textContent = 'Hubungkan akun';
    updateControls();
  }
}

async function initializeOAuth() {
  void initializeSeo();
  try {
    const status = await apiRequest('/api/youtube/status', { method: 'GET' });
    const oauth = await waitForIdentityLibrary();
    codeClient = oauth.initCodeClient({
      client_id: status.clientId,
      scope: UPLOAD_SCOPE,
      ux_mode: 'popup',
      callback: handleAuthorizationCode,
      error_callback: (error) => {
        clearAuthorizationTimer();
        connectButton.textContent = 'Hubungkan akun';
        setStatus(error?.message || 'Jendela persetujuan tidak dapat dibuka. Coba lagi.', true);
        updateControls();
      }
    });
    if (status.connected) {
      $('#accountLabel').textContent = 'Memulihkan koneksi…';
      $('#accountHint').textContent = 'Mengambil akses YouTube secara otomatis.';
      try {
        setConnected(await refreshAccessToken());
      } catch (error) {
        setDisconnected(error.message || 'Hubungkan kembali akun YouTube untuk melanjutkan.');
        if (error.reconnect) setStatus(error.message, true);
      }
    } else {
      setDisconnected('Hubungkan akun YouTube sekali untuk mengaktifkan akses otomatis.');
    }
    updateControls();
  } catch (error) {
    $('#accountLabel').textContent = 'Koneksi belum tersedia';
    $('#accountHint').textContent = error.message;
    setStatus(error.message, true);
    updateControls();
  }
}

async function initializeSeo() {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const status = await apiRequest('/api/youtube/seo-status', { method: 'GET' });
      seoAiConfigured = Boolean(status.configured);
      $('#seoHint').textContent = seoAiConfigured
        ? ''
        : 'Isi GEMINI_YOUTUBE_API_KEY khusus SEO YouTube di Render; key terjemahan tidak dipakai.';
      updateControls();
      void maybeGenerateSeoMetadata();
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
  seoAiConfigured = false;
  $('#seoHint').textContent = lastError?.message || 'Status AI SEO belum dapat diperiksa.';
  updateControls();
}

async function loadHandoffVideo() {
  if (new URLSearchParams(location.search).get('handoff') !== 'latest') return;
  try {
    const record = await loadYoutubeHandoff();
    if (!record?.blob) throw new Error('Hasil video belum ditemukan. Kembali ke halaman Subtitle Video dan ekspor hasil terlebih dahulu.');
    const file = new File([record.blob], record.name || 'videoteks-subtitle.mp4', { type: record.blob.type || 'video/mp4' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    loadingHandoff = true;
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event('change'));
    loadingHandoff = false;
    sourceCaptions = String(record.captions || '');
    sourceLanguage = String(record.language || '');
    $('#handoffHint').textContent = sourceLanguage
      ? `Video hasil subtitle/terjemahan (${sourceLanguage}) dimasukkan otomatis.`
      : 'Video hasil subtitle dimasukkan otomatis.';
    $('#handoffHint').hidden = false;
    void maybeGenerateSeoMetadata();
  } catch (error) {
    loadingHandoff = false;
    $('#handoffHint').textContent = error.message || 'Hasil video tidak dapat dimuat.';
    $('#handoffHint').hidden = false;
  }
  updateControls();
}

connectButton.addEventListener('click', () => {
  if (!codeClient || uploading) return;
  connectButton.disabled = true;
  connectButton.textContent = 'Menunggu…';
  setStatus('Menunggu persetujuan akses unggah…');
  codeClient.requestCode({ prompt: 'consent select_account' });
  clearAuthorizationTimer();
  authorizationTimer = setTimeout(() => {
    connectButton.textContent = 'Hubungkan akun';
    updateControls();
    if (!accessToken) setStatus('Jika jendela persetujuan ditutup, tekan Hubungkan akun untuk mencoba lagi.');
  }, 30000);
});

disconnectButton.addEventListener('click', async () => {
  disconnectButton.disabled = true;
  try {
    await apiRequest('/api/youtube/connection', { method: 'DELETE' });
    setDisconnected('Koneksi YouTube telah dilepas.');
  } catch (error) {
    setStatus(error.message || 'Koneksi YouTube gagal dilepas.', true);
  } finally {
    disconnectButton.disabled = false;
    updateControls();
  }
});

fileInput.addEventListener('change', () => {
  selectedFile = fileInput.files?.[0] || null;
  if (!loadingHandoff) {
    sourceCaptions = '';
    sourceLanguage = '';
    seoContentConsent.checked = true;
    $('#handoffHint').hidden = true;
  }
  if (!selectedFile) {
    $('#fileName').textContent = 'Belum ada video dipilih';
    updateControls();
    return;
  }
  if (selectedFile.type && !selectedFile.type.startsWith('video/')) {
    selectedFile = null;
    fileInput.value = '';
    $('#fileName').textContent = 'Pilih file video yang valid';
    setStatus('File yang dipilih bukan file video.', true);
    updateControls();
    return;
  }
  $('#fileName').textContent = `${selectedFile.name} · ${displayBytes(selectedFile.size)}`;
  if (!titleInput.value.trim()) {
    titleInput.value = selectedFile.name.replace(/\.[^.]+$/, '').slice(0, 100);
    $('#titleCount').textContent = String(titleInput.value.length);
  }
  successLink.hidden = true;
  updateControls();
  if (!loadingHandoff) void maybeGenerateSeoMetadata();
});

titleInput.addEventListener('input', () => {
  $('#titleCount').textContent = String(titleInput.value.length);
  updateControls();
});

descriptionInput.addEventListener('input', () => {
  $('#descriptionCount').textContent = String(descriptionInput.value.length);
});

async function generateSeoMetadata() {
  if (seoBusy || uploading) return;
  const analyzeVideo = Boolean(selectedFile && !sourceCaptions.trim());
  if (analyzeVideo && !seoContentConsent.checked) {
    setStatus('Centang persetujuan analisis audio dan cuplikan gambar agar Gemini membuat SEO dari isi video.', true);
    return;
  }
  const topic = seoTopic.value.trim() || (!sourceCaptions.trim() && !analyzeVideo
    ? (selectedFile?.name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
    : '');
  if (!sourceCaptions.trim() && !topic && !analyzeVideo) {
    setStatus('Pilih video atau masukkan topik SEO agar Gemini memiliki konteks.', true);
    return;
  }
  seoBusy = true;
  seoButton.textContent = analyzeVideo ? 'Gemini membaca video…' : 'Gemini sedang membuat…';
  setStatus(analyzeVideo ? 'Gemini sedang membaca audio dan cuplikan gambar video…' : 'AI SEO sedang menyiapkan judul, deskripsi, dan tag…');
  updateControls();
  try {
    const body = analyzeVideo ? new FormData() : JSON.stringify({
        captions: sourceCaptions,
        language: sourceLanguage,
        topic
      });
    if (analyzeVideo) {
      body.append('video', selectedFile, selectedFile.name);
      body.append('consent', 'true');
      body.append('topic', seoTopic.value.trim());
    }
    const data = await apiRequest(analyzeVideo ? '/api/youtube/seo-video-metadata' : '/api/youtube/seo-metadata', {
      method: 'POST',
      ...(analyzeVideo ? {} : { headers: { 'Content-Type': 'application/json' } }),
      body
    });
    titleInput.value = String(data.title || '').slice(0, 100);
    descriptionInput.value = String(data.description || '').slice(0, 5000);
    seoTags = Array.isArray(data.tags) ? data.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
    $('#seoTagsHint').textContent = seoTags.length
      ? `Tag otomatis: ${seoTags.join(', ')}`
      : 'Tidak ada tag yang dikembalikan AI.';
    titleInput.dispatchEvent(new Event('input'));
    descriptionInput.dispatchEvent(new Event('input'));
    setStatus('Judul, deskripsi, dan tag SEO sudah dibuat otomatis. Anda tinggal menekan Upload ke YouTube.');
  } catch (error) {
    setStatus(error.message || 'AI SEO gagal membuat metadata.', true);
  } finally {
    seoBusy = false;
    seoButton.textContent = 'Buat judul & deskripsi SEO (Gemini)';
    updateControls();
  }
}

async function maybeGenerateSeoMetadata() {
  if (seoGenerationPromise || !seoAiConfigured || (!sourceCaptions.trim() && !seoTopic.value.trim() && !selectedFile)) return;
  if (selectedFile && !sourceCaptions.trim() && !seoContentConsent.checked) {
    setStatus('Centang persetujuan analisis isi video untuk membuat judul dan deskripsi SEO otomatis.');
    return;
  }
  seoGenerationPromise = generateSeoMetadata();
  try { await seoGenerationPromise; } finally { seoGenerationPromise = null; }
}

seoButton.addEventListener('click', () => { void generateSeoMetadata(); });
seoContentConsent.addEventListener('change', () => { if (seoContentConsent.checked) void maybeGenerateSeoMetadata(); });

rightsCheck.addEventListener('change', updateControls);

$('#uploadForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!accessToken || !selectedFile || !titleInput.value.trim() || !rightsCheck.checked || uploading || seoBusy) return;
  uploading = true;
  progress.hidden = false;
  progressFill.style.width = '0%';
  successLink.hidden = true;
  setStatus('Menyiapkan unggahan langsung…');
  updateControls();
  const metadata = {
    snippet: {
      title: titleInput.value.trim(),
      description: descriptionInput.value.trim(),
      ...(seoTags.length ? { tags: seoTags } : {})
    },
    status: { privacyStatus: $('#privacyStatus').value }
  };
  try {
    accessToken = await refreshAccessToken();
    const uploaded = await uploadVideo(selectedFile, metadata, accessToken);
    progressFill.style.width = '100%';
    setStatus('Unggahan selesai. Video mungkin masih diproses sebelum dapat diputar.');
    successLink.href = `https://www.youtube.com/watch?v=${encodeURIComponent(uploaded.id)}`;
    successLink.hidden = false;
  } catch (error) {
    if (error.status === 401 || error.reconnect) {
      setDisconnected(error.message || 'Hubungkan kembali akun sebelum mengunggah.');
    }
    setStatus(error.message || 'Unggahan gagal. Periksa koneksi dan setelan akun, lalu coba lagi.', true);
  } finally {
    uploading = false;
    updateControls();
  }
});

void initializeOAuth();
void loadHandoffVideo();
