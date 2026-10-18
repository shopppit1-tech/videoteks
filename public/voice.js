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
let audioUrl = null;
let busy = false;

downloadLink.addEventListener('click', () => {
  downloadLink.download = downloadName('suara-ai', '.wav');
});

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

function setStatus(message, error = false) {
  status.textContent = message;
  status.className = `status ${error ? 'error' : ''}`;
}
function updateCount() {
  count.textContent = textInput.value.length.toLocaleString('id-ID');
  generateBtn.disabled = busy || !textInput.value.trim();
}
textInput.addEventListener('input', updateCount);

generateBtn.onclick = async () => {
  const text = textInput.value.trim();
  if (!text || busy) return;
  busy = true;
  updateCount();
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
      throw new Error('Audio tidak dapat dibuat. Coba lagi sebentar lagi.');
    }
    const blob = await response.blob();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(blob);
    audioResult.src = audioUrl;
    downloadLink.href = audioUrl;
    audioHandoff.href = 'audio.html?generated=1&standalone=1';
    try { await saveAudioForHandoff(blob); } catch { /* unduhan tetap tersedia jika penyimpanan browser tidak tersedia */ }
    result.hidden = false;
    const historyStatus = response.headers.get('X-History-Saved') === 'true' ? 'Riwayat tersimpan.' : 'Riwayat belum tersimpan.';
    setStatus(`Selesai. Audio siap diputar atau diunduh. ${historyStatus}`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    busy = false;
    generateBtn.textContent = 'Buat suara AI';
    updateCount();
  }
};
updateCount();
