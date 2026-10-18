import { authenticatedFetch, requireLogin } from './firebase-client.js';
import { downloadName } from './download-utils.js';

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
const textInput = $('#textInput');
const voiceSelect = $('#voiceSelect');
const styleInput = $('#styleInput');
const count = $('#count');
const generateBtn = $('#generateBtn');
const result = $('#result');
const audioResult = $('#audioResult');
const downloadLink = $('#downloadLink');
const audioHandoff = $('#audioHandoff');
const status = $('#status');
const videoInput = $('#narrationVideo');
const videoInfo = $('#videoInfo');
const videoNarrationBtn = $('#videoNarrationBtn');
const videoStatus = $('#videoStatus');
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
let audioUrl = null;
let metadataUrl = null;
let selectedVideoDuration = null;
let busy = false;
let videoBusy = false;
let audioHandoffSaved = false;

function setStatus(message, error = false) {
  status.textContent = message;
  status.className = `status ${error ? 'error' : ''}`;
}

function setVideoStatus(message, error = false) {
  videoStatus.textContent = message;
  videoStatus.className = `status ${error ? 'error' : ''}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'durasi belum diketahui';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return minutes ? `${minutes} menit ${remainder} detik` : `${remainder} detik`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function updateVideoControls() {
  const file = videoInput.files?.[0];
  videoNarrationBtn.disabled = busy || videoBusy || !file || file.size > MAX_VIDEO_BYTES;
  generateBtn.disabled = busy || videoBusy || !textInput.value.trim();
}

function updateCount() {
  count.textContent = textInput.value.length.toLocaleString('id-ID');
  updateVideoControls();
}

function saveAudioForHandoff(blob) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('videoteks-audio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('generated');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('generated', 'readwrite');
      transaction.objectStore('generated').put({ blob, name: 'suara-ai.wav', createdAt: Date.now() }, 'latest');
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  });
}

function saveVideoForHandoff(file) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('videoteks-audio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('generated');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('generated', 'readwrite');
      transaction.objectStore('generated').put({ blob: file, name: file.name || 'video-narasi.mp4', createdAt: Date.now() }, 'narration-video-latest');
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  });
}

async function createVoice(textValue) {
  const text = String(textValue || '').trim();
  if (!text || busy) return false;
  busy = true;
  audioHandoffSaved = false;
  updateVideoControls();
  result.hidden = true;
  generateBtn.textContent = 'Membuat suara...';
  setStatus('Sedang membuat audio...');
  try {
    const response = await authenticatedFetch('/api/generate-voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: voiceSelect.value, style: styleInput.value })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Audio tidak dapat dibuat. Coba lagi sebentar lagi.');
    }
    const blob = await response.blob();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(blob);
    audioResult.src = audioUrl;
    downloadLink.href = audioUrl;
    audioHandoff.href = 'audio.html?generated=1&standalone=1';
    try {
      await saveAudioForHandoff(blob);
      audioHandoffSaved = true;
    } catch { /* audio tetap dapat diputar atau diunduh jika penyimpanan browser tidak tersedia */ }
    result.hidden = false;
    const historyStatus = response.headers.get('X-History-Saved') === 'true' ? 'Riwayat tersimpan.' : 'Riwayat belum tersimpan.';
    setStatus(`Selesai. Audio siap diputar atau diunduh. ${historyStatus}`);
    return true;
  } catch (error) {
    setStatus(error.message, true);
    return false;
  } finally {
    busy = false;
    generateBtn.textContent = 'Buat suara AI';
    updateVideoControls();
  }
}

downloadLink.addEventListener('click', () => {
  downloadLink.download = downloadName('suara-ai', '.wav');
});
textInput.addEventListener('input', updateCount);
generateBtn.addEventListener('click', () => createVoice(textInput.value));

videoInput.addEventListener('change', () => {
  if (metadataUrl) URL.revokeObjectURL(metadataUrl);
  metadataUrl = null;
  selectedVideoDuration = null;
  const file = videoInput.files?.[0];
  if (!file) {
    videoInfo.textContent = 'Belum ada video dipilih.';
    setVideoStatus('Pilih video lalu tekan tombol.');
    updateVideoControls();
    return;
  }
  videoInfo.textContent = `${file.name} · ${formatBytes(file.size)} · memeriksa durasi…`;
  if (file.size > MAX_VIDEO_BYTES) {
    videoInfo.textContent = `${file.name} · ${formatBytes(file.size)}`;
    setVideoStatus('Ukuran video maksimal 500 MB.', true);
  } else {
    setVideoStatus('Video dipilih. Siap dibuat.');
    metadataUrl = URL.createObjectURL(file);
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      selectedVideoDuration = Number.isFinite(probe.duration) ? probe.duration : null;
      videoInfo.textContent = `${file.name} · ${formatBytes(file.size)} · ${formatDuration(selectedVideoDuration)}`;
      if (metadataUrl) URL.revokeObjectURL(metadataUrl);
      metadataUrl = null;
    };
    probe.onerror = () => {
      videoInfo.textContent = `${file.name} · ${formatBytes(file.size)} · durasi diperiksa server`;
      if (metadataUrl) URL.revokeObjectURL(metadataUrl);
      metadataUrl = null;
    };
    probe.src = metadataUrl;
  }
  updateVideoControls();
});

videoNarrationBtn.addEventListener('click', async () => {
  const file = videoInput.files?.[0];
  if (!file || videoBusy || busy) return;
  if (file.size > MAX_VIDEO_BYTES) {
    setVideoStatus('Ukuran video maksimal 500 MB.', true);
    return;
  }
  videoBusy = true;
  videoNarrationBtn.textContent = 'Menganalisis video…';
  updateVideoControls();
  setVideoStatus('Menganalisis audio dan cuplikan video. Mohon tunggu…');
  try {
    const formData = new FormData();
    formData.append('video', file);
    const response = await authenticatedFetch('/api/voice/video-narration', { method: 'POST', body: formData });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Narasi dari video gagal dibuat.');
    const narration = String(data.narration || '').trim();
    if (!narration) throw new Error('AI tidak mengembalikan teks narasi. Coba lagi.');
    textInput.value = narration;
    updateCount();
    const duration = Number.isFinite(Number(data.durationSeconds)) ? Number(data.durationSeconds) : selectedVideoDuration;
    setVideoStatus(`Narasi untuk video ${formatDuration(duration)} selesai. Membuat suara otomatis…`);
    const voiceCreated = await createVoice(narration);
    if (!voiceCreated) {
      setVideoStatus('Naskah sudah dibuat. Pembuatan suara gagal; lihat pesan pada bagian Teks narasi.', true);
    } else if (!audioHandoffSaved) {
      setVideoStatus('Suara berhasil dibuat, tetapi audio tidak dapat disiapkan untuk dipindahkan. Silakan unduh audio dan lanjutkan secara manual.', true);
    } else {
      await saveVideoForHandoff(file);
      audioHandoff.href = 'audio.html?generated=1&video=1&standalone=1';
      setVideoStatus('Narasi, audio, dan video siap. Membuka menu Ganti Audio…');
      audioHandoff.click();
    }
  } catch (error) {
    setVideoStatus(error.message, true);
  } finally {
    videoBusy = false;
    videoNarrationBtn.textContent = 'Buat narasi + suara otomatis';
    updateVideoControls();
  }
});

updateCount();
