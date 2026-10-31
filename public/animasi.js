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
    ? history.ideas.slice().reverse().slice(0, 8).map(item => `<article class="history-item"><strong>${esc(item.idea)}</strong><small>${esc(item.date)} · Gemini API</small></article>`).join('')
    : '<div class="empty">Belum ada ide yang dibuat Gemini.</div>';
  $('jobs').innerHTML = history.jobs.length
    ? history.jobs.slice().reverse().slice(0, 8).map(job => `<article class="history-item"><strong>${esc(job.title)}</strong><small>${esc(job.date)} · ${esc(job.aspect)}</small><p class="job-status">${esc(job.status)}</p>${job.videoUrl ? `<p><a class="result-link" href="${esc(job.videoUrl)}" target="_blank" rel="noopener">▶ Buka / unduh video MP4</a></p>` : ''}${job.hook ? `<p>Hook: ${esc(job.hook)}</p>` : ''}${job.payoff ? `<p>Payoff: ${esc(job.payoff)}</p>` : ''}</article>`).join('')
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
      ? `${data.videoModel} siap dipanggil dari backend. Pemeriksaan ini memastikan API key ada, tetapi tidak memverifikasi akses tier berbayar. API tidak ditagih sampai Anda menyetujui generasi.`
      : 'GEMINI_API_KEY_2 belum tersedia di server. Tambahkan key Gemini yang memiliki akses ke model video pada environment Render.';
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
    button.textContent = '✦ Buat ide unik dengan AI';
  }
}

async function waitForAnimation(jobId, button, historyEntry) {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const data = await api(`/api/animasi/jobs/${encodeURIComponent(jobId)}`);
    button.textContent = data.message || 'Gemini sedang membuat video…';
    historyEntry.status = data.message || 'Gemini sedang membuat video…';
    save();
    render();
    if (data.status === 'completed') return data;
    if (data.status === 'failed') throw new Error(data.error || 'Generasi video gagal.');
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('Generasi masih berjalan terlalu lama. Jangan mulai permintaan baru sebelum memeriksa riwayat job ini.');
}

async function createJob() {
  const idea = $('idea').value.trim();
  if (!idea) {
    alert('Ide animasi wajib diisi.');
    return;
  }
  const estimatedCost = 'Gemini Omni Flash hanya tersedia pada tier berbayar. Tarif resmi sekitar US$0,10 per detik video output 720p. Patokan untuk 30 detik output akhir sekitar US$3, tetapi alur extension beberapa tahap dapat menambah biaya karena tiap interaction bisa menghasilkan output. Retry juga menambah pemakaian. Lanjutkan?';
  if (!window.confirm(estimatedCost)) return;

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
      status: accepted.message || 'Job video dimulai…',
      jobId: accepted.jobId
    };
    history.jobs.push(historyEntry);
    save();
    render();

    const result = await waitForAnimation(accepted.jobId, button, historyEntry);
    historyEntry.title = result.plan?.title || historyEntry.title;
    historyEntry.status = 'Selesai · Gemini Omni Flash · sekitar 30 detik';
    historyEntry.videoUrl = result.videoUrl;
    historyEntry.hook = result.plan?.hook || '';
    historyEntry.payoff = result.plan?.payoff || '';
    save();
    render();
    alert('Video Gemini selesai dibuat dan tersedia sebagai MP4 tanpa audio. Periksa hasilnya sebelum dipublikasikan.');
  } catch (error) {
    if (historyEntry) {
      historyEntry.status = `Gagal: ${error.message}`;
      save();
      render();
    }
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = '✦ Buat cerita video 30 detik';
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
