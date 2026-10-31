import { authenticatedFetch, requireLogin } from './firebase-client.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const KEY = 'videoteks.animasi.studio.history';
const POLL_INTERVAL_MS = 1200;
const MAX_WAIT_MS = 12 * 60 * 1000;

let history;
try {
  history = JSON.parse(localStorage.getItem(KEY) || '{"ideas":[],"jobs":[]}');
} catch {
  history = { ideas: [], jobs: [] };
}

function save() { localStorage.setItem(KEY, JSON.stringify(history)); }
function stamp() { return new Date().toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }); }

async function api(path, options = {}) {
  const response = await authenticatedFetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Server error ${response.status}`);
  return data;
}

function render() {
  $('ideaHistory').innerHTML = history.ideas.length
    ? history.ideas.slice().reverse().slice(0, 8).map(item => `<article class="history-item"><strong>${esc(item.idea)}</strong><small>${esc(item.date)} · lokal</small></article>`).join('')
    : '<div class="empty">Belum ada ide yang dipilih.</div>';
  $('jobs').innerHTML = history.jobs.length
    ? history.jobs.slice().reverse().slice(0, 8).map(job => `<article class="history-item"><strong>${esc(job.title)}</strong><small>${esc(job.date)} · ${esc(job.aspect)} · 20 detik</small><p class="job-status">${esc(job.status)}</p>${job.videoUrl ? `<p><a class="result-link" href="${esc(new URL(job.videoUrl, 'https://terjemah-video.onrender.com').href)}" target="_blank" rel="noopener">▶ Buka / unduh MP4</a></p>` : ''}${job.frameUrls?.length ? `<div class="frame-gallery">${job.frameUrls.map((url, index) => `<a href="${esc(new URL(url, 'https://terjemah-video.onrender.com').href)}" target="_blank" rel="noopener"><img src="${esc(new URL(url, 'https://terjemah-video.onrender.com').href)}" alt="Adegan ${index + 1}" loading="lazy"></a>`).join('')}</div>` : ''}${job.hook ? `<p>Hook: ${esc(job.hook)}</p>` : ''}${job.payoff ? `<p>Payoff: ${esc(job.payoff)}</p>` : ''}${job.narration ? `<p class="narration-preview">Narasi: ${esc(job.narration)}</p>` : ''}</article>`).join('')
    : '<div class="empty">Belum ada produksi. Buat animasi gratis pertama kamu.</div>';
  $('queueCount').textContent = `${history.jobs.length} JOB`;
}

function addHistoryIdea(idea) {
  history.ideas.push({ idea, date: stamp() });
  save();
  render();
}

async function refreshLocalStatus() {
  try {
    const data = await api('/api/animasi/status');
    $('generatorBadge').textContent = data.noPaidApiCalls ? 'GRATIS · LOKAL' : 'STATUS TIDAK VALID';
    $('generatorInfo').textContent = `${data.storyModel} · ${data.imageModel} · ${data.narrationModel}. Tidak ada panggilan API berbayar pada generator ini.`;
  } catch (error) {
    $('generatorBadge').textContent = 'STATUS TIDAK TERSEDIA';
    $('generatorInfo').textContent = error.message;
  }
}

async function generateIdea() {
  const button = $('newIdea');
  button.disabled = true;
  button.textContent = 'Memilih ide lokal…';
  try {
    const data = await api('/api/animasi/idea', { method: 'POST', body: JSON.stringify({}) });
    $('idea').value = data.idea;
    addHistoryIdea(data.idea);
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = '✦ Pilih ide cerita gratis';
  }
}

async function waitForAnimation(jobId, button, historyEntry) {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const data = await api(`/api/animasi/jobs/${encodeURIComponent(jobId)}`);
    button.textContent = data.message || 'Sedang merender animasi lokal…';
    historyEntry.status = data.message || 'Sedang merender animasi lokal…';
    save();
    render();
    if (data.status === 'completed') return data;
    if (data.status === 'failed') throw new Error(data.error || 'Produksi animasi gagal.');
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('Render masih berjalan. Periksa kembali riwayat sebelum mengirim job baru.');
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
  if (!response.ok) throw new Error(`MP4 gagal diambil untuk editor (HTTP ${response.status}).`);
  const blob = await response.blob();
  if (!blob.size) throw new Error('MP4 hasil kosong; file tidak diteruskan.');
  const database = await openGeneratedDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('generated', 'readwrite');
      const name = `${String(title || 'animasi-video').replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 70)}.mp4`;
      transaction.objectStore('generated').put({ blob, name }, 'video-latest');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('MP4 gagal disimpan sementara.'));
      transaction.onabort = () => reject(transaction.error || new Error('Penyimpanan MP4 dibatalkan.'));
    });
  } finally {
    database.close();
  }
  location.assign('app.html?generated=1&from=animation');
}

async function createJob() {
  const idea = $('idea').value.trim();
  if (!idea) return alert('Ide animasi wajib diisi.');
  const button = $('produce');
  let historyEntry = null;
  button.disabled = true;
  button.textContent = 'Menyiapkan render lokal…';
  try {
    const accepted = await api('/api/animasi/produce', {
      method: 'POST',
      body: JSON.stringify({ idea, style: $('visualStyle').value, aspectRatio: $('aspect').value })
    });
    historyEntry = {
      title: idea.slice(0, 90), date: stamp(), aspect: $('aspect').value,
      status: accepted.message || 'Render lokal dimulai…', jobId: accepted.jobId
    };
    history.jobs.push(historyEntry);
    save();
    render();
    const result = await waitForAnimation(accepted.jobId, button, historyEntry);
    historyEntry.title = result.plan?.title || historyEntry.title;
    historyEntry.status = 'Selesai · MP4 20 detik · membuka editor subtitle tanpa auto-transkripsi…';
    historyEntry.videoUrl = result.videoUrl;
    historyEntry.frameUrls = result.frameUrls || [];
    historyEntry.hook = result.plan?.hook || '';
    historyEntry.payoff = result.plan?.payoff || '';
    historyEntry.narration = result.narration || '';
    save();
    render();
    button.textContent = 'Meneruskan MP4 ke editor…';
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
    button.textContent = '✦ Buat animasi gratis + buka editor';
    refreshLocalStatus();
  }
}

$('heroCreate').onclick = () => {
  $('productionPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('produce').focus(), 350);
};
$('newIdea').onclick = generateIdea;
$('produce').onclick = createJob;
$('clearIdeas').onclick = () => { history.ideas = []; save(); render(); };
$('connectGoogle').onclick = () => { location.href = 'youtube.html'; };
render();
requireLogin().then(refreshLocalStatus).catch(() => {});
