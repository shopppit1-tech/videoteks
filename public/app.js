import { authenticatedFetch, requireLogin } from './firebase-client.js';
import { downloadName } from './download-utils.js';
import { saveYoutubeHandoff } from './youtube-handoff.js';

await requireLogin();

// Fallback for standalone Android/PWA webviews that swallow native page scrolling.
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

const state = { file: null, segments: [], translationTarget: '', color: '#ec4899', template: 'pill', fontSize: 24, position: 'bottom', fontFamily: 'DejaVu Sans', outputFormat: 'source' };
const previewFontStacks = {
  'DejaVu Sans': 'system-ui, -apple-system, "Segoe UI", sans-serif',
  'DejaVu Serif': 'Georgia, "Times New Roman", serif',
  'DejaVu Sans Mono': '"Courier New", Courier, monospace',
  'Liberation Sans': 'Arial, Helvetica, sans-serif'
};
function srtTimestamp(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const wholeSeconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}
function segmentsToSrt(segments) {
  return segments.map((segment, index) => `${index + 1}\n${srtTimestamp(segment.start)} --> ${srtTimestamp(segment.end)}\n${String(segment.text || '').trim()}\n`).join('\n');
}
const $ = (s) => document.querySelector(s);
const video = $('#video');
const fileInput = $('#fileInput');
const preview = $('#subtitlePreview');
const status = $('#status');
const caption = $('#caption');
const sourceLanguageSelect = $('#sourceLanguage');
let sourceLanguageManual = false;
sourceLanguageSelect.onchange = () => { sourceLanguageManual = sourceLanguageSelect.value !== 'auto'; };
let transcribeController = null;
let currentHistoryId = null;
let historySaveTimer = null;
let generatedMetadata = null;
let localAiWorker = null;
let localTaskId = 0;
const pendingLocalTasks = new Map();

function getLocalAiWorker() {
  if (localAiWorker) return localAiWorker;
  const worker = new Worker(new URL('./local-ai.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => {
    const message = event.data || {};
    const task = pendingLocalTasks.get(message.id);
    if (!task) return;
    if (message.type === 'progress') {
      task.onProgress?.(message);
      return;
    }
    pendingLocalTasks.delete(message.id);
    task.cleanup();
    if (message.type === 'result') task.resolve(message.result);
    else task.reject(new Error(message.error || 'Pemrosesan lokal gagal.'));
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'Worker lokal tidak dapat dijalankan di browser ini.');
    for (const task of pendingLocalTasks.values()) {
      task.cleanup();
      task.reject(error);
    }
    pendingLocalTasks.clear();
    worker.terminate();
    if (localAiWorker === worker) localAiWorker = null;
  };
  localAiWorker = worker;
  return worker;
}

function runLocalAi(type, payload, { signal, onProgress } = {}) {
  if (signal?.aborted) return Promise.reject(new DOMException('Pemrosesan dibatalkan.', 'AbortError'));
  const worker = getLocalAiWorker();
  const id = ++localTaskId;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      pendingLocalTasks.delete(id);
      worker.terminate();
      if (localAiWorker === worker) localAiWorker = null;
      reject(new DOMException('Pemrosesan dibatalkan.', 'AbortError'));
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    pendingLocalTasks.set(id, { resolve, reject, onProgress, cleanup });
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.postMessage({ id, type, payload });
  });
}

function showLocalProgress(message) {
  if (!message?.message) return;
  setStatus(message.message);
  const title = $('#busyTitle');
  const details = $('#busyText');
  if (title && ['extract', 'asr-model', 'asr', 'translate-model', 'translate'].includes(message.stage)) title.textContent = message.message;
  if (details && message.progress !== null && Number.isFinite(message.progress)) details.textContent = `${Math.max(0, Math.min(100, message.progress))}%`;
}

function scheduleHistorySave() {
  if (!currentHistoryId) return;
  clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(async () => {
    try {
      const response = await authenticatedFetch(`/api/history/${encodeURIComponent(currentHistoryId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: state.segments.map((segment) => segment.text).join('\n'),
          segments: state.segments,
          settings: { color: state.color, template: state.template, fontSize: state.fontSize, position: state.position, fontFamily: state.fontFamily, outputFormat: state.outputFormat }
        })
      });
      if (!response.ok) throw new Error('Riwayat belum tersimpan.');
    } catch {
      setStatus('Perubahan belum tersimpan di riwayat. Periksa koneksi, lalu coba lagi.', true);
    }
  }, 900);
}

function fmt(s) { return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }
function setStatus(text, error = false) { status.textContent = text; status.className = `status ${error ? 'error' : ''}`; }
function setBusy(active, text = 'Memproses di perangkat…') { const overlay = $('#busyOverlay'); const button = $('#transcribeBtn'); if (overlay) overlay.classList.toggle('show', active); if (button) { button.disabled = active; button.style.opacity = active ? '.65' : '1'; button.textContent = active ? '⏳ Sedang bekerja…' : '↻ Buat Ulang Teks'; } const translateButton = $('#translateBtn'); if (translateButton) translateButton.disabled = active; const exportButton = $('#exportBtn'); if (exportButton) exportButton.disabled = active; const title = $('#busyTitle'); if (title) title.textContent = text; }
function syncCaption() {
  if (state.segments[0]) {
    state.segments[0].text = caption.value;
    const firstInput = $('#segmentList input[data-i="0"]');
    if (firstInput && document.activeElement !== firstInput) firstInput.value = caption.value;
  }
  const count = $('#charCount');
  if (count) count.textContent = `${caption.value.length}/120`;
  syncPreview();
}
function syncPreview() {
  const time = Number(video.currentTime) || 0;
  const active = state.segments.find((s) => time >= Number(s.start) && time <= Number(s.end));
  const text = state.segments.length ? active?.text || '' : caption.value;
  preview.textContent = text;
  preview.style.display = text.trim() ? 'block' : 'none';
  preview.style.opacity = '1';
}
function applyPreviewFormat() {
  if (!video.videoWidth || !video.videoHeight) return;
  const originalRatio = video.videoWidth / video.videoHeight;
  const ratio = state.outputFormat === 'short' ? 9 / 16 : state.outputFormat === 'square' ? 1 : state.outputFormat === 'landscape' ? 16 / 9 : originalRatio;
  const maxHeight = Math.min(window.innerHeight * 0.42, 360);
  const maxWidth = Math.min($('#videoWrap').parentElement.clientWidth - 16, maxHeight * ratio);
  $('#videoWrap').style.aspectRatio = `${ratio}`;
  $('#videoWrap').style.width = `${Math.max(180, maxWidth)}px`;
  $('#videoWrap').style.margin = 'auto';
  video.style.objectFit = state.outputFormat === 'source' ? 'contain' : 'cover';
}
function esc(value) { return String(value).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function applyPreviewStyle() {
  preview.className = `subtitle ${state.template}`;
  preview.style.fontSize = `${state.fontSize}px`;
  preview.style.fontFamily = previewFontStacks[state.fontFamily] || previewFontStacks['DejaVu Sans'];
  preview.style.color = state.color === 'gradient' ? '#fff' : state.color;
  preview.style.background = state.template === 'gradient' || state.color === 'gradient'
    ? 'linear-gradient(90deg,#06b6d4,#8b5cf6,#ec4899)'
    : '';
  preview.style.top = state.position === 'top' ? '12%' : state.position === 'middle' ? '45%' : '';
  preview.style.bottom = state.position === 'bottom' ? '12%' : 'auto';
  preview.style.transform = state.position === 'middle' ? 'translateY(-50%)' : '';
}
function drawSegments() {
  const box = $('#segmentList');
  box.innerHTML = state.segments.map((s, i) => `<div class="segment"><span>${fmt(s.start)}</span><input data-i="${i}" value="${esc(s.text)}"></div>`).join('');
  box.querySelectorAll('input').forEach((input) => input.oninput = () => {
    state.segments[+input.dataset.i].text = input.value;
    if (+input.dataset.i === 0) { caption.value = input.value; syncCaption(); }
    else syncPreview();
    scheduleHistorySave();
  });
}
caption.oninput = () => { syncCaption(); scheduleHistorySave(); };
$('#clearCaption').onclick = () => { caption.value = ''; syncCaption(); scheduleHistorySave(); };
fileInput.onchange = (event) => {
  state.file = event.target.files[0];
  if (!state.file) return;
  if (transcribeController) transcribeController.abort();
  if (!sourceLanguageManual) sourceLanguageSelect.value = 'auto';
  $('#youtubeHandoffLink').hidden = true;
  currentHistoryId = null;
  clearTimeout(historySaveTimer);
  state.segments = [];
  state.translationTarget = '';
  caption.value = '';
  drawSegments(); syncCaption();
  video.src = URL.createObjectURL(state.file);
  video.onloadedmetadata = () => { $('#seek').max = video.duration; $('#duration').textContent = fmt(video.duration); applyPreviewFormat(); };
  $('#empty').style.display = 'none';
  $('#videoWrap').classList.add('has-video');
  setStatus('Video dipilih. Model lokal akan memproses suara di perangkat; unduhan model awal memerlukan internet.');
  void transcribeCurrentFile();
};
$('#playBtn').onclick = () => video.paused ? video.play() : video.pause();
$('#muteBtn').onclick = () => { video.muted = !video.muted; $('#muteBtn').textContent = video.muted ? '🔇 Suara dimatikan' : '🔊 Suara asli'; };

video.ontimeupdate = () => { $('#seek').value = video.currentTime; $('#time').textContent = fmt(video.currentTime); syncPreview(); };
$('#seek').oninput = () => { video.currentTime = $('#seek').value; };

document.querySelectorAll('.swatch').forEach((button) => button.onclick = () => {
  document.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
  button.classList.add('active'); state.color = button.dataset.color; applyPreviewStyle(); setStatus(`Warna subtitle: ${button.querySelector('span')?.textContent || 'dipilih'}.`);
  scheduleHistorySave();
});
document.querySelectorAll('.mini').forEach((button) => button.onclick = () => {
  document.querySelectorAll('.mini').forEach((x) => x.classList.remove('active'));
  button.classList.add('active'); state.template = button.dataset.template; applyPreviewStyle(); scheduleHistorySave();
});
$('#fontSize').oninput = (e) => { state.fontSize = Number(e.target.value); $('#fontSizeValue').textContent = `${state.fontSize}px`; applyPreviewStyle(); scheduleHistorySave(); };
$('#position').onchange = (e) => { state.position = e.target.value; applyPreviewStyle(); scheduleHistorySave(); };
$('#fontFamily').onchange = (e) => { state.fontFamily = e.target.value; applyPreviewStyle(); scheduleHistorySave(); };
$('#outputFormat').onchange = (e) => { state.outputFormat = e.target.value; applyPreviewFormat(); scheduleHistorySave(); };
async function transcribeCurrentFile() {
  if (!state.file) return setStatus('Pilih video terlebih dahulu.', true);
  if (transcribeController) transcribeController.abort();
  if (!sourceLanguageManual) sourceLanguageSelect.value = 'auto';
  const controller = new AbortController();
  const selectedFile = state.file;
  transcribeController = controller;
  currentHistoryId = null;
  generatedMetadata = null;
  setStatus('Menyiapkan pemrosesan lokal. File video tidak dikirim ke API AI.'); setBusy(true);
  try {
    const result = await runLocalAi('transcribe', { file: selectedFile }, { signal: controller.signal, onProgress: showLocalProgress });
    if (state.file !== selectedFile || transcribeController !== controller) return;
    state.segments = result.segments || [];
    const target = $('#translationTarget').value || 'id';
    state.translationTarget = target;
    let translationNotice = '';
    if (state.segments.length) {
      try {
        const translated = await runLocalAi('translate', {
          segments: state.segments,
          sourceLanguage: $('#sourceLanguage').value,
          targetLanguage: target
        }, { signal: controller.signal, onProgress: showLocalProgress });
        if (state.file !== selectedFile || transcribeController !== controller) return;
        state.segments = translated.segments;
        sourceLanguageSelect.value = translated.targetLanguage;
        sourceLanguageManual = false;
        translationNotice = ` Diterjemahkan otomatis ke ${$('#translationTarget').selectedOptions[0]?.textContent || target}.`;
      } catch (translationError) {
        if (translationError.name === 'AbortError') throw translationError;
        translationNotice = ` Transkripsi siap, tetapi terjemahan otomatis belum berhasil: ${translationError.message} Pilih bahasa ucapan secara manual lalu tekan Terjemahkan.`;
      }
    }
    caption.value = state.segments[0]?.text || '';
    syncCaption(); drawSegments();
    setStatus(`${state.segments.length} segmen siap diedit.${translationNotice} Semua pemrosesan berlangsung lokal; video dan teks tidak dikirim ke AI API atau riwayat cloud.`);
    try {
      await saveYoutubeHandoff(selectedFile, {
        name: selectedFile.name || 'video-subtitle.mp4',
        captions: state.segments.map((segment) => segment.text).join('\n'),
        title: generatedMetadata?.title,
        description: generatedMetadata?.description,
        tags: generatedMetadata?.tags
      });
      $('#youtubeHandoffLink').hidden = false;
    } catch (handoffError) {
      $('#youtubeHandoffLink').hidden = true;
      setStatus(`Subtitle siap, tetapi belum dapat disiapkan untuk YouTube: ${handoffError.message}`, true);
    }
  } catch (error) {
    if (error.name !== 'AbortError' && state.file === selectedFile) setStatus(`${error.message} Video dan teks tetap diproses tanpa API AI.`, true);
  } finally {
    if (transcribeController === controller) { transcribeController = null; setBusy(false); }
  }
}
$('#transcribeBtn').onclick = transcribeCurrentFile;

$('#translateBtn').onclick = async () => {
  const target = $('#translationTarget').value.trim();
  if (!state.segments.length) return setStatus('Buat teks subtitle terlebih dahulu.', true);
  if (!target) return setStatus('Pilih bahasa tujuan terjemahan.', true);
  const targetLabel = $('#translationTarget').selectedOptions[0]?.textContent || target;
  const button = $('#translateBtn');
  button.disabled = true;
  const sourceLanguage = $('#sourceLanguage').value;
  setStatus(`Menyiapkan penerjemah lokal untuk ${targetLabel}…`);
  try {
    const result = await runLocalAi('translate', {
      segments: state.segments,
      sourceLanguage,
      targetLanguage: target
    }, { onProgress: showLocalProgress });
    state.segments = result.segments;
    state.translationTarget = target;
    sourceLanguageSelect.value = result.targetLanguage;
    sourceLanguageManual = false;
    caption.value = state.segments[0]?.text || '';
    drawSegments();
    syncCaption();
    scheduleHistorySave();
    try {
      if (!state.file) throw new Error('Video sumber tidak tersedia.');
      await saveYoutubeHandoff(state.file, {
        name: state.file.name || 'video-terjemahan.mp4',
        captions: state.segments.map((segment) => segment.text).join('\n'),
        language: targetLabel,
        title: generatedMetadata?.title,
        description: generatedMetadata?.description,
        tags: generatedMetadata?.tags
      });
      $('#youtubeHandoffLink').hidden = false;
      const sourceLabel = sourceLanguage === 'auto' ? `Bahasa sumber terdeteksi: ${result.sourceLanguage}. ` : '';
      setStatus(`${sourceLabel}Terjemahan ${targetLabel} siap. Model berjalan lokal; hasil tidak dikirim ke AI API atau riwayat cloud.`);
    } catch (handoffError) {
      $('#youtubeHandoffLink').hidden = true;
      setStatus(`Terjemahan ${targetLabel} siap, tetapi video belum dapat disiapkan untuk YouTube: ${handoffError.message}`, true);
    }
  } catch (error) {
    setStatus(error.message || 'Terjemahan gagal dibuat.', true);
  } finally {
    button.disabled = false;
  }
};

function loadGeneratedVideo(force = false) {
  if (!force && new URLSearchParams(location.search).get('generated') !== '1') return;
  const request = indexedDB.open('videoteks-audio', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('generated');
  request.onerror = () => setStatus('Video hasil Ganti Audio tidak dapat dibaca.', true);
  request.onsuccess = () => {
    const database = request.result;
    const getRequest = database.transaction('generated', 'readonly').objectStore('generated').get('video-latest');
    getRequest.onsuccess = () => {
      const record = getRequest.result;
      database.close();
      if (!record?.blob) { setStatus('Video hasil Ganti Audio tidak ditemukan.', true); return; }
      try {
        const transfer = new DataTransfer();
        transfer.items.add(new File([record.blob], record.name || 'video-audio-baru.mp4', { type: record.blob.type || 'video/mp4' }));
        fileInput.files = transfer.files;
        fileInput.dispatchEvent(new Event('change'));
      } catch { setStatus('Video tersimpan, tetapi browser tidak dapat memasukkannya otomatis.', true); }
    };
    getRequest.onerror = () => { database.close(); setStatus('Video hasil Ganti Audio tidak dapat dibaca.', true); };
  };
}

window.addEventListener('message', (event) => {
  if (event.origin === location.origin && event.source === window.parent && event.data?.source === 'videoteks-shell' && event.data.type === 'load-generated-video') {
    loadGeneratedVideo(true);
  }
});
loadGeneratedVideo();
$('#exportBtn').onclick = async () => {
  if (!state.file || !state.segments.length) return setStatus('Buat subtitle terlebih dahulu.', true);
  const exportConfirmed = window.confirm('Ekspor MP4 mengirim video ke server Render untuk dirender dengan FFmpeg. Ini bukan API AI, tetapi file video keluar dari perangkat. Lanjutkan?');
  if (!exportConfirmed) return setStatus('Ekspor dibatalkan. Video tetap berada di perangkat.');
  const form = new FormData(); form.append('video', state.file); form.append('segments', JSON.stringify(state.segments));
  form.append('color', state.color); form.append('template', state.template); form.append('fontSize', String(state.fontSize)); form.append('position', state.position); form.append('fontFamily', state.fontFamily); form.append('format', state.outputFormat);
  const button = $('#exportBtn');
  const originalButton = button.innerHTML;
  const showLoading = (label) => { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span>${label}`; };
  showLoading('Memproses video...');
  setStatus('Video sedang diproses. Jangan tutup halaman.');
  try {
    const response = await authenticatedFetch('/api/export', { method: 'POST', body: form });
    if (!response.ok) { const data = await response.json(); throw Error(data.error); }
    showLoading('Mengunduh video...');
    setStatus('Render selesai. Sedang mengunduh file video...');
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
        const progress = totalBytes ? Math.min(99, Math.floor(receivedBytes / totalBytes * 100)) : null;
        const label = progress === null ? `Mengunduh video... ${(receivedBytes / 1048576).toFixed(1)} MB` : `Mengunduh video... ${progress}%`;
        showLoading(label); setStatus(label);
      }
      blob = new Blob(chunks, { type: response.headers.get('content-type') || 'video/mp4' });
    } else {
      blob = await response.blob();
    }
    showLoading('Mengunduh video... 100%'); setStatus('Mengunduh video... 100%');
    try {
      await saveYoutubeHandoff(blob, {
        name: 'videoteks-subtitle.mp4',
        captions: state.segments.map((segment) => segment.text).join('\n'),
        subtitleSrt: segmentsToSrt(state.segments),
        language: state.translationTarget,
        title: generatedMetadata?.title,
        description: generatedMetadata?.description,
        tags: generatedMetadata?.tags
      });
      $('#youtubeHandoffLink').hidden = false;
    } catch (handoffError) {
      $('#youtubeHandoffLink').hidden = true;
      setStatus(`Video berhasil dibuat dan akan diunduh, tetapi tidak dapat disiapkan untuk YouTube: ${handoffError.message}`, true);
    }
    const downloadUrl = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = downloadUrl; link.download = downloadName('videoteks-subtitle', '.mp4'); link.click();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);
    if (!$('#youtubeHandoffLink').hidden) setStatus('Video siap. Sudah diunduh dan bisa diteruskan ke halaman YouTube.');
    else if (!status.classList.contains('error')) setStatus('Selesai. Video dengan template pilihan sudah diunduh.');
  } catch (error) { setStatus(error.message, true); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); button.innerHTML = originalButton; }
};
applyPreviewStyle(); syncCaption();
