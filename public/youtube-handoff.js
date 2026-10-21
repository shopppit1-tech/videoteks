const DATABASE_NAME = 'videoteks-youtube-handoff';
const STORE_NAME = 'items';
const HANDOFF_KEY = 'latest';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Penyimpanan browser tidak tersedia.'));
  });
}

export async function saveYoutubeHandoff(blob, details = {}) {
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error('File video hasil tidak ditemukan.');
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put({
        blob,
        name: String(details.name || 'videoteks-subtitle.mp4').slice(0, 180),
        captions: String(details.captions || '').slice(0, 50000),
        subtitleSrt: String(details.subtitleSrt || ''),
        language: String(details.language || '').slice(0, 80),
        title: String(details.title || '').slice(0, 100),
        description: String(details.description || '').slice(0, 5000),
        tags: Array.isArray(details.tags) ? details.tags.map((tag) => String(tag).slice(0, 80)).slice(0, 30) : [],
        createdAt: Date.now()
      }, HANDOFF_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Hasil video tidak dapat disimpan sementara.'));
      transaction.onabort = () => reject(transaction.error || new Error('Penyimpanan hasil video dibatalkan.'));
    });
  } finally {
    database.close();
  }
}

export async function loadYoutubeHandoff() {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(HANDOFF_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Hasil video tidak dapat dibaca.'));
    });
  } finally {
    database.close();
  }
}
