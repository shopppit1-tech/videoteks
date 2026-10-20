import { authenticatedFetch, requireLogin } from './firebase-client.js';

const status = document.querySelector('#historyStatus');
const list = document.querySelector('#historyList');

function showStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle('history-error', error);
  status.hidden = false;
}

function kindLabel(type) {
  return ({
    'video-transcription': 'Transkripsi video',
    'video-translation': 'Terjemahan video',
    'audio-replace': 'Ganti audio',
    'ai-voice': 'Suara AI',
    'youtube-auto-upload': 'Drive → YouTube otomatis'
  })[type] || 'Riwayat aktivitas';
}

function addMeta(container, label, value) {
  if (value === undefined || value === null || value === '') return;
  const row = document.createElement('p');
  row.className = 'history-card__meta';
  const strong = document.createElement('strong');
  strong.textContent = `${label}: `;
  row.append(strong, document.createTextNode(String(value)));
  container.append(row);
}

function addTextDetails(container, label, text) {
  if (!text) return;
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = label;
  const content = document.createElement('pre');
  content.textContent = String(text);
  details.append(summary, content);
  container.append(details);
}

function makeHistoryCard(item) {
  const type = item.type || 'video-transcription';
  const card = document.createElement('article');
  card.className = 'history-card';
  const head = document.createElement('div');
  head.className = 'history-card__head';
  const titleBlock = document.createElement('div');
  const badge = document.createElement('span');
  badge.className = 'history-card__type';
  badge.textContent = kindLabel(type);
  const title = document.createElement('h2');
  title.className = 'history-card__title';
  title.textContent = item.title || item.fileName || kindLabel(type);
  const date = document.createElement('p');
  date.className = 'history-card__date';
  const createdAt = Number(item.createdAt) || Date.parse(item.createdAt || '');
  date.textContent = Number.isFinite(createdAt) ? new Date(createdAt).toLocaleString('id-ID') : 'Waktu tidak tersedia';
  titleBlock.append(badge, title, date);

  const deleteButton = document.createElement('button');
  deleteButton.className = 'history-card__delete';
  deleteButton.type = 'button';
  deleteButton.textContent = 'Hapus';
  deleteButton.addEventListener('click', async () => {
    if (!confirm('Hapus riwayat ini secara permanen?')) return;
    deleteButton.disabled = true;
    try {
      const response = await authenticatedFetch(`/api/history/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Riwayat gagal dihapus.');
      }
      card.remove();
      if (!list.children.length) showStatus('Belum ada aktivitas tersimpan.');
    } catch (error) {
      deleteButton.disabled = false;
      showStatus(error.message, true);
    }
  });
  head.append(titleBlock, deleteButton);

  const content = document.createElement('div');
  content.className = 'history-card__content';
  if (type === 'ai-voice') {
    addMeta(content, 'Suara', item.voice);
    addMeta(content, 'Gaya', item.style || 'Natural');
    addTextDetails(content, 'Lihat teks narasi', item.inputText || item.text);
  } else if (type === 'audio-replace') {
    addMeta(content, 'Video', item.fileName);
    addMeta(content, 'Audio', item.audioFileName);
    addMeta(content, 'Mode', ({ auto: 'Otomatis', manual: 'Manual', original: 'Kecepatan asli' })[item.audioMode] || item.audioMode);
    if (item.speed) addMeta(content, 'Kecepatan audio', `${item.speed}×`);
    if (item.videoDuration) addMeta(content, 'Durasi video', `${item.videoDuration} dtk`);
  } else if (type === 'video-translation') {
    addMeta(content, 'Target', item.translationTarget);
    addTextDetails(content, 'Lihat teks asal', item.sourceText);
    addTextDetails(content, 'Lihat hasil terjemahan', item.translatedText || item.text);
  } else if (type === 'youtube-auto-upload') {
    addMeta(content, 'Video', item.fileName);
    addMeta(content, 'Status', ({ uploaded: 'Berhasil diunggah', error: 'Gagal', empty: 'Antrean kosong' })[item.uploadStatus] || item.uploadStatus);
    addMeta(content, 'Error', item.error);
    if (item.youtubeUrl) {
      const link = document.createElement('a');
      link.className = 'history-card__link';
      link.href = item.youtubeUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Buka video di YouTube';
      content.append(link);
    }
    addTextDetails(content, 'Lihat deskripsi YouTube', item.description);
  } else {
    addMeta(content, 'Video', item.fileName);
    const transcript = item.text || (Array.isArray(item.segments) ? item.segments.map((segment) => segment.text || '').join('\n') : '');
    addTextDetails(content, 'Lihat teks transkripsi', transcript);
    if (item.translatedText) addTextDetails(content, `Lihat hasil terjemahan${item.translationTarget ? ` (${item.translationTarget})` : ''}`, item.translatedText);
  }
  card.append(head, content);
  return card;
}

async function loadHistory() {
  showStatus('Memuat riwayat…');
  try {
    const response = await authenticatedFetch('/api/history');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Riwayat tidak dapat dimuat.');
    const items = Array.isArray(data.items) ? data.items : [];
    list.replaceChildren(...items.map(makeHistoryCard));
    list.hidden = false;
    if (!items.length) showStatus('Belum ada aktivitas tersimpan.');
    else status.hidden = true;
  } catch (error) {
    showStatus(error.message, true);
  }
}

await requireLogin();
await loadHistory();
