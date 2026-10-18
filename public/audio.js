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
const videoInput = $('#videoInput');
const audioInput = $('#audioInput');
const videoPreview = $('#videoPreview');
const audioPreview = $('#audioPreview');
const videoName = $('#videoName');
const audioName = $('#audioName');
const speedMode = $('#speedMode');
const manualSpeed = $('#manualSpeed');
const manualSpeedSlider = $('#manualSpeedSlider');
const manualSpeedValue = $('#manualSpeedValue');
const fitInfo = $('#fitInfo');
const replaceBtn = $('#replaceBtn');
const status = $('#status');
const progress = $('#progress');
const progressFill = $('#progressFill');
const resultActions = $('#resultActions');
let videoUrl = null;
let audioUrl = null;
let busy = false;

function saveVideoForHandoff(blob) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('videoteks-audio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('generated');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('generated', 'readwrite');
      transaction.objectStore('generated').put({ blob, name: 'video-audio-baru.mp4', createdAt: Date.now() }, 'video-latest');
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  });
}

function loadGeneratedAudio(force = false, includeVideo = new URLSearchParams(location.search).get('video') === '1') {
  if (!force && new URLSearchParams(location.search).get('generated') !== '1') return;
  const request = indexedDB.open('videoteks-audio', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('generated');
  request.onerror = () => setStatus('Penyimpanan audio AI tidak tersedia di browser.', true);
  request.onsuccess = () => {
    const database = request.result;
    const store = database.transaction('generated', 'readonly').objectStore('generated');
    const audioRequest = store.get('latest');
    const videoRequest = includeVideo ? store.get('narration-video-latest') : null;
    let audioRecord = null;
    let videoRecord = null;
    let remaining = includeVideo ? 2 : 1;
    const finish = () => {
      remaining -= 1;
      if (remaining > 0) return;
      database.close();
      try {
        if (audioRecord?.blob) {
          const file = new File([audioRecord.blob], audioRecord.name || 'suara-ai.wav', { type: audioRecord.blob.type || 'audio/wav' });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          audioInput.files = transfer.files;
          audioInput.dispatchEvent(new Event('change'));
        }
        if (videoRecord?.blob) {
          const file = new File([videoRecord.blob], videoRecord.name || 'video-narasi.mp4', { type: videoRecord.blob.type || 'video/mp4' });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          videoInput.files = transfer.files;
          videoInput.dispatchEvent(new Event('change'));
        }
        const messages = [];
        if (audioRecord?.blob) messages.push('Audio AI sudah dimasukkan.');
        else messages.push('Audio AI tidak ditemukan. Buat audio terlebih dahulu.');
        if (includeVideo) {
          if (videoRecord?.blob) messages.push('Video sumber juga sudah dimasukkan.');
          else messages.push('Video sumber tidak ditemukan; pilih video kembali.');
        } else {
          messages.push('Pilih video untuk melanjutkan.');
        }
        setStatus(messages.join(' '), !audioRecord?.blob || (includeVideo && !videoRecord?.blob));
      } catch {
        setStatus('File tersimpan, tetapi browser tidak dapat memasukkan audio atau video secara otomatis.', true);
      }
    };
    audioRequest.onsuccess = () => { audioRecord = audioRequest.result; finish(); };
    audioRequest.onerror = () => { database.close(); setStatus('Audio AI tidak dapat dibaca.', true); };
    if (videoRequest) {
      videoRequest.onsuccess = () => { videoRecord = videoRequest.result; finish(); };
      videoRequest.onerror = () => { database.close(); setStatus('Video sumber tidak dapat dibaca.', true); };
    }
  };
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.className = `status ${error ? 'error' : ''}`;
}
function updateButton() {
  replaceBtn.disabled = busy || !videoInput.files[0] || !audioInput.files[0];
  videoInput.disabled = busy;
  audioInput.disabled = busy;
  speedMode.disabled = busy;
  manualSpeedSlider.disabled = busy;
}
function updateFitInfo() {
  manualSpeed.hidden = speedMode.value !== 'manual';
  manualSpeedValue.textContent = `${Number(manualSpeedSlider.value).toFixed(2).replace('.', ',')}×`;
  if (!videoInput.files[0] || !audioInput.files[0]) {
    fitInfo.hidden = true;
    return;
  }
  fitInfo.hidden = false;
  const videoDuration = Number(videoPreview.duration);
  const audioDuration = Number(audioPreview.duration);
  if (speedMode.value === 'original') {
    fitInfo.textContent = 'Kecepatan asli; audio pendek diulang, audio panjang dipotong.';
    return;
  }
  if (!Number.isFinite(videoDuration) || !Number.isFinite(audioDuration) || videoDuration <= 0 || audioDuration <= 0) {
    fitInfo.textContent = 'Membaca durasi video dan audio...';
    return;
  }
  const speed = speedMode.value === 'manual' ? Number(manualSpeedSlider.value) : audioDuration / videoDuration;
  const adjustedDuration = audioDuration / speed;
  if (speedMode.value === 'manual') {
    const tail = adjustedDuration > videoDuration + 0.05 ? 'akhir audio dipotong' : adjustedDuration < videoDuration - 0.05 ? 'akhir video hening' : 'durasi pas';
    fitInfo.textContent = `Manual ${speed.toFixed(2)}× · hasil ${adjustedDuration.toFixed(1)} dtk · ${tail}.`;
  } else {
    fitInfo.textContent = `Otomatis ${speed.toFixed(2)}× · hasil ${adjustedDuration.toFixed(1)} dtk.`;
  }
}
function showProgress(percent) {
  progress.hidden = false;
  progress.setAttribute('aria-valuenow', String(percent));
  progressFill.style.width = `${percent}%`;
}
function clearProgress() {
  progress.hidden = true;
  progress.setAttribute('aria-valuenow', '0');
  progressFill.style.width = '0%';
}

videoPreview.addEventListener('loadedmetadata', updateFitInfo);
audioPreview.addEventListener('loadedmetadata', updateFitInfo);
speedMode.onchange = updateFitInfo;
manualSpeedSlider.oninput = updateFitInfo;

videoInput.onchange = () => {
  const file = videoInput.files[0];
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = file ? URL.createObjectURL(file) : null;
  videoName.textContent = file ? file.name : 'Belum ada video';
  videoPreview.hidden = !file;
  if (file) {
    videoPreview.src = videoUrl;
    videoPreview.muted = true;
    videoPreview.load();
  } else {
    videoPreview.removeAttribute('src');
  }
  updateButton();
  updateFitInfo();
};

audioInput.onchange = () => {
  const file = audioInput.files[0];
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = file ? URL.createObjectURL(file) : null;
  audioName.textContent = file ? file.name : 'Belum ada file audio';
  audioPreview.hidden = !file;
  if (file) {
    audioPreview.src = audioUrl;
    audioPreview.load();
  } else {
    audioPreview.removeAttribute('src');
  }
  updateButton();
  updateFitInfo();
};

replaceBtn.onclick = async () => {
  const videoFile = videoInput.files[0];
  const audioFile = audioInput.files[0];
  if (!videoFile || !audioFile || busy) return;
  const form = new FormData();
  form.append('video', videoFile);
  form.append('audio', audioFile);
  form.append('audioMode', speedMode.value);
  form.append('manualSpeed', manualSpeedSlider.value);
  busy = true;
  updateButton();
  clearProgress();
  const modeMessage = speedMode.value === 'auto' ? 'Menyamakan kecepatan audio dengan durasi video...' : speedMode.value === 'manual' ? `Mengatur kecepatan audio ${Number(manualSpeedSlider.value).toFixed(2)}×...` : 'Mengganti suara tanpa mengubah kecepatan...';
  setStatus(modeMessage);
  replaceBtn.textContent = speedMode.value === 'manual' ? 'Menerapkan kecepatan...' : 'Memproses video...';

  try {
    const response = await authenticatedFetch('/api/replace-audio', { method: 'POST', body: form });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Video gagal diproses.');
    }

    const totalBytes = Number(response.headers.get('content-length')) || 0;
    const reader = response.body?.getReader();
    let blob;
    if (reader) {
      const chunks = [];
      let receivedBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedBytes += value.byteLength;
        if (totalBytes) {
          const percent = Math.min(99, Math.floor(receivedBytes / totalBytes * 100));
          showProgress(percent);
          setStatus(`Mengunduh hasil... ${percent}%`);
          replaceBtn.textContent = `Mengunduh... ${percent}%`;
        } else {
          setStatus(`Mengunduh hasil... ${(receivedBytes / 1048576).toFixed(1)} MB`);
        }
      }
      blob = new Blob(chunks, { type: response.headers.get('content-type') || 'video/mp4' });
    } else {
      blob = await response.blob();
    }

    showProgress(100);
    replaceBtn.textContent = 'Mengunduh... 100%';
    setStatus('Unduhan siap. Menyimpan video baru...');
    try { await saveVideoForHandoff(blob); } catch { /* unduhan tetap tersedia jika penyimpanan browser tidak tersedia */ }
    resultActions.hidden = false;
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = downloadName('video-audio-baru', '.mp4');
    link.click();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);
    const completion = speedMode.value === 'manual' ? `Video diunduh dengan kecepatan audio ${Number(manualSpeedSlider.value).toFixed(2)}×.` : speedMode.value === 'auto' ? 'Kecepatan audio disesuaikan otomatis dengan video.' : 'Kecepatan asli audio dipertahankan.';
    const historyStatus = response.headers.get('X-History-Saved') === 'true' ? 'Riwayat tersimpan.' : 'Riwayat belum tersimpan; aktifkan Cloud Firestore API untuk menyimpan aktivitas.';
    setStatus(`Selesai. ${completion} ${historyStatus}`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    busy = false;
    replaceBtn.textContent = 'Ganti suara & unduh';
    updateButton();
  }
};

window.addEventListener('message', (event) => {
  if (event.origin === location.origin && event.source === window.parent && event.data?.source === 'videoteks-shell' && event.data.type === 'load-generated-audio') {
    loadGeneratedAudio(true, event.data.includeVideo);
  }
});
loadGeneratedAudio();
