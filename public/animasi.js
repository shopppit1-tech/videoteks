import { authenticatedFetch, requireLogin } from './firebase-client.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const KEY = 'videoteks.animasi.studio.history';
const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 35 * 60 * 1000;

let history;
try {
  history = JSON.parse(localStorage.getItem(KEY) || '{"ideas":[],"jobs":[]}');
} catch {
  history = { ideas: [], jobs: [] };
}

function save() {
  localStorage.setItem(KEY, JSON.stringify(history));
}

function stamp() {
  return new Date().toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
}

async function api(path, options = {}) {
  const response = await authenticatedFetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Server error ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function render() {
  const ideas = $('ideaHistory');
  ideas.innerHTML = history.ideas.length
    ? history.ideas.slice().reverse().slice(0, 8).map(item => `<article class="history-item"><strong>${esc(item.idea)}</strong><small>${esc(item.date)} · Gemini 3.8</small></article>`).join('')
    : '<div class="empty">Belum ada ide yang dibuat Gemini.</div>';
  $('jobs').innerHTML = history.jobs.length
    ? history.jobs.slice().reverse().slice(0, 8).map(job => `<article class="history-item"><strong>${esc(job.title)}</strong><small>${esc(job.date)} · ${esc(job.aspect)} · 20 detik</small><p class="job-status">${esc(job.status)}</p>${job.videoUrl ? `<p><a class="result-link" href="${esc(new URL(job.videoUrl, 'https://terjemah-video.onrender.com').href)}" target="_blank" rel="noopener">▶ Buka / unduh MP4</a></p>` : ''}${job.frameUrls?.length ? `<div class="frame-gallery">${job.frameUrls.map((url, index) => `<a href="${esc(new URL(url, 'https://terjemah-video.onrender.com').href)}" target="_blank" rel="noopener"><img src="${esc(new URL(url, 'https://terjemah-video.onrender.com').href)}" alt="Adegan ${index + 1}" loading="lazy"></a>`).join('')}</div>` : ''}${job.hook ? `<p>Hook: ${esc(job.hook)}</p>` : ''}${job.payoff ? `<p>Payoff: ${esc(job.payoff)}</p>` : ''}${job.narration ? `<p class="narration-preview">Narasi: ${esc(job.narration)}</p>` : ''}</article>`).join('')
    : '<div class="empty">Belum ada produksi. Buat animasi pertama kamu.</div>';
  $('queueCount').textContent = `${history.jobs.length} JOB`;
}

function addHistoryIdea(idea) {
  history.ideas.push({ idea, date: stamp() });
  save();
  render();
}

async function refreshGeminiStatus() {
  try {
    const data = await api('/api/animasi/status');
    const ready = data.geminiKey2Configured;
    $('geminiBadge').textContent = ready ? 'API KEY TERSEDIA' : 'API KEY BELUM ADA';
    $('geminiBadge').className = `pill ${ready ? 'green' : ''}`;
    $('geminiInfo').textContent = ready
      ? `${data.storyModel} (cerita) · ${data.imageModel} (gambar) · ${data.narrationModel} (narasi). Key Gemini nomor 2 tersedia; tier dan saldo kredit tidak diverifikasi.`
      : 'GEMINI_API_KEY_2 belum tersedia di server. Tambahkan key Gemini nomor 2 pada environment Render.';
  } catch (error) {
    $('geminiBadge').textContent = 'STATUS TIDAK TERSEDIA';
    $('geminiInfo').textContent = error.message;
  }
}

async function generateIdea() {
  const button = $('newIdea');
  button.disabled = true;
  button.textContent = 'Gemini sedang membuat ide…';
  try {
    const data = await api('/api/animasi/idea', { method: 'POST', body: JSON.stringify({}) });
    $('idea').value = data.idea;
    addHistoryIdea(data.idea);
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = '✦ Buat ide cerita baru';
  }
}

async function waitForAnimation(jobId, button, historyEntry) {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const data = await api(`/api/animasi/jobs/${encodeURIComponent(jobId)}`);
    button.textContent = data.message || 'Gemini sedang membuat animasi…';
    historyEntry.status = data.message || 'Gemini sedang membuat animasi…';
    save();
    render();
    if (data.status === 'completed') return data;
    if (data.status === 'failed') throw new Error(data.error || 'Produksi animasi gagal.');
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('Produksi masih berjalan. Periksa riwayat job ini sebelum mengirim permintaan baru.');
}

function openGeneratedDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('videoteks-audio', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('generated')) request.result.createObjectStore('generated');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Penyimpanan browser tidak tersedia.'));
  });
}

async function handoffToSubtitlePage(videoUrl, title) {
  const response = await authenticatedFetch(videoUrl);
  if (!response.ok) throw new Error(`MP4 tidak dapat diambil untuk editor subtitle (HTTP ${response.status}).`);
  const blob = await response.blob();
  if (!blob.size) throw new Error('MP4 hasil kosong; file tidak diteruskan.');
  const database = await openGeneratedDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('generated', 'readwrite');
      transaction.objectStore('generated').put({ blob, name: `${String(title || 'animasi-video').replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 70)}.mp4` }, 'video-latest');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('MP4 gagal disimpan sementara untuk editor subtitle.'));
      transaction.onabort = () => reject(transaction.error || new Error('Penyimpanan MP4 dibatalkan.'));
    });
  } finally {
    database.close();
  }
  location.assign('app.html?generated=1&from=animation');
}

async function createJob() {
  const idea = $('idea').value.trim();
  if (!idea) {
    alert('Ide animasi wajib diisi.');
    return;
  }
  const confirmation = 'Buat animasi 20 detik dengan Gemini API key nomor 2? Patokan paid tier saat ini: empat gambar 1K sekitar US$0,14 ditambah TTS 20 detik sekitar US$0,0045; teks, tier, pajak, harga yang berubah, dan percobaan ulang dapat menambah biaya. Lanjutkan?';
  if (!window.confirm(confirmation)) return;

  const button = $('produce');
  let historyEntry = null;
  button.disabled = true;
  button.textContent = 'Menyiapkan permintaan Gemini…';
  try {
    const accepted = await api('/api/animasi/produce', {
      method: 'POST',
      body: JSON.stringify({ idea, style: $('visualStyle').value, aspectRatio: $('aspect').value })
    });
    historyEntry = {
      title: idea.slice(0, 90),
      date: stamp(),
      aspect: $('aspect').value,
      status: accepted.message || 'Job animasi dimulai…',
      jobId: accepted.jobId
    };
    history.jobs.push(historyEntry);
    save();
    render();

    const result = await waitForAnimation(accepted.jobId, button, historyEntry);
    historyEntry.title = result.plan?.title || historyEntry.title;
    historyEntry.status = 'Selesai · MP4 20 detik · membuka Terjemah Video…';
    historyEntry.videoUrl = result.videoUrl;
    historyEntry.frameUrls = result.frameUrls || [];
    historyEntry.hook = result.plan?.hook || '';
    historyEntry.payoff = result.plan?.payoff || '';
    historyEntry.narration = result.narration || '';
    save();
    render();
    button.textContent = 'Meneruskan MP4 ke Subtitle Video…';
    await handoffToSubtitlePage(result.videoUrl, historyEntry.title);
  } catch (error) {
    if (historyEntry) {
      historyEntry.status = `Gagal / handoff terhenti: ${error.message}`;
      save();
      render();
    }
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = '✦ Buat animasi + buka Terjemah Video';
    refreshGeminiStatus();
  }
}

$('heroCreate').onclick = () => {
  document.querySelector('#productionPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('produce').focus(), 350);
};
$('newIdea').onclick = generateIdea;
$('produce').onclick = createJob;
$('clearIdeas').onclick = () => {
  history.ideas = [];
  save();
  render();
};
$('connectGoogle').onclick = () => { location.href = 'youtube.html'; };
render();
requireLogin().then(refreshGeminiStatus).catch(() => {});
