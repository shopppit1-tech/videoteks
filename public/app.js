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

const state = { file: null, segments: [], translationTarget: '', color: '#ec4899', template: 'pill', fontSize: 8, position: 'bottom', fontFamily: 'DejaVu Sans', outputFormat: 'source' };
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
let transcribeController = null;
let currentHistoryId = null;
let historySaveTimer = null;
let generatedMetadata = null;

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
function setBusy(active, text = 'AI sedang mengenali suara...') { const overlay = $('#busyOverlay'); const button = $('#transcribeBtn'); if (overlay) overlay.classList.toggle('show', active); if (button) { button.disabled = active; button.style.opacity = active ? '.65' : '1'; button.textContent = active ? '⏳ Sedang bekerja...' : '↻ Buat Ulang Teks'; } const title = $('#busyTitle'); if (title) title.textContent = text; }
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
  setStatus('Video dipilih. AI mulai mengenali suara secara otomatis...');
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
  const controller = new AbortController();
  const selectedFile = state.file;
  transcribeController = controller;
  const form = new FormData(); form.append('video', selectedFile);
  setStatus('Mengambil suara dan membuat teks otomatis...'); setBusy(true);
  try {
    const response = await authenticatedFetch('/api/transcribe', { method: 'POST', body: form, signal: controller.signal });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : { error: response.ok ? 'Server mengembalikan respons yang tidak dikenali.' : `Server sedang memulai ulang atau sibuk (HTTP ${response.status}). Coba lagi.` };
    if (!response.ok) throw Error(data.error);
    if (state.file !== selectedFile || transcribeController !== controller) return;
    currentHistoryId = data.historyId || null;
    generatedMetadata = data.metadata || null;
    state.segments = data.segments || [];
    caption.value = state.segments[0]?.text || '';
    syncCaption(); drawSegments();
    setStatus(data.historySaved
      ? `${state.segments.length} segmen siap diedit. Riwayat tersimpan.`
      : `${state.segments.length} segmen siap diedit. ${data.historyError || 'Riwayat belum tersimpan.'}`, !data.historySaved);
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
    if (error.name !== 'AbortError' && state.file === selectedFile) setStatus(error.message, true);
  } finally {
    if (transcribeController === controller) { transcribeController = null; setBusy(false); }
  }
}
$('#transcribeBtn').onclick = transcribeCurrentFile;

$('#translateBtn').onclick = async () => {
  const target = $('#translationTarget').value.trim();
  if (!state.segments.length) return setStatus('Buat teks subtitle terlebih dahulu.', true);
  if (!target) return setStatus('Pilih bahasa tujuan terjemahan.', true);
  const button = $('#translateBtn');
  button.disabled = true;
  setStatus(`Menerjemahkan subtitle ke ${target}...`);
  try {
    const response = await authenticatedFetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: state.segments.map((segment) => segment.text).join('\n'),
        target,
        historyId: currentHistoryId
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Terjemahan gagal dibuat.');
    const translatedLines = String(data.text || '').replace(/\r/g, '').split('\n');
    if (translatedLines.length !== state.segments.length) {
      throw new Error('Jumlah baris hasil terjemahan tidak cocok dengan subtitle. Coba ulangi atau edit teks secara manual.');
    }
    state.segments = state.segments.map((segment, index) => ({ ...segment, text: translatedLines[index].trim() }));
    state.translationTarget = target;
    caption.value = state.segments[0]?.text || '';
    drawSegments();
    syncCaption();
    scheduleHistorySave();
    try {
      if (!state.file) throw new Error('Video sumber tidak tersedia.');
      await saveYoutubeHandoff(state.file, {
        name: state.file.name || 'video-terjemahan.mp4',
        captions: state.segments.map((segment) => segment.text).join('\n'),
        language: target,
        title: generatedMetadata?.title,
        description: generatedMetadata?.description,
        tags: generatedMetadata?.tags
      });
      $('#youtubeHandoffLink').hidden = false;
      setStatus(data.historySaved
        ? `Terjemahan ${target} siap. Video dan subtitle bisa diteruskan ke YouTube. Riwayat diperbarui.`
        : `Terjemahan ${target} siap. Video dan subtitle bisa diteruskan ke YouTube.`);
    } catch (handoffError) {
      $('#youtubeHandoffLink').hidden = true;
      setStatus(`Terjemahan ${target} siap, tetapi video belum dapat disiapkan untuk YouTube: ${handoffError.message}`, true);
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
