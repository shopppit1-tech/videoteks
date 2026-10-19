import { authenticatedFetch, requireLogin } from './firebase-client.js';

await requireLogin();
const $ = (selector) => document.querySelector(selector);
const youtubeConnect = $('#youtubeConnect');
const youtubeDisconnect = $('#youtubeDisconnect');
const driveConnect = $('#driveConnect');
const driveDisconnect = $('#driveDisconnect');
const saveButton = $('#save');
const folderInput = $('#folder');
const enabledInput = $('#enabled');
const statusNode = $('#status');
const resultLink = $('#result');
let youtubeClient = null;
let driveClient = null;
let youtubeConnected = false;
let driveConnected = false;
let saving = false;
let authTimer = null;

function setStatus(message, tone = '') {
  statusNode.textContent = message;
  statusNode.className = `status${tone ? ` ${tone}` : ''}`;
}
function parseError(response, fallback) {
  return response.json().catch(() => ({})).then((data) => data.error || fallback);
}
async function api(url, options = {}) {
  const response = await authenticatedFetch(url, options);
  if (!response.ok) throw new Error(await parseError(response, `Permintaan gagal (HTTP ${response.status}).`));
  return response.json().catch(() => ({}));
}
function setAccount(type, connected, message = '') {
  const prefix = type === 'youtube' ? 'youtube' : 'drive';
  const label = $(`#${prefix}Label`);
  const hint = $(`#${prefix}Hint`);
  const connect = $(`#${prefix}Connect`);
  const disconnect = $(`#${prefix}Disconnect`);
  label.textContent = connected ? `${type === 'youtube' ? 'YouTube' : 'Google Drive'} terhubung` : `${type === 'youtube' ? 'YouTube' : 'Google Drive'} belum terhubung`;
  hint.textContent = message || (connected ? (type === 'drive' ? 'Izin baca-saja aktif.' : 'Akun siap menerima unggahan.') : 'Hubungkan akun untuk melanjutkan.');
  connect.hidden = connected;
  disconnect.hidden = !connected;
  connect.disabled = saving || (type === 'youtube' ? !youtubeClient : !driveClient);
  disconnect.disabled = saving;
}
function waitForGoogle(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve(window.google.accounts.oauth2);
    const script = $('#googleIdentityScript');
    const timer = setTimeout(() => reject(new Error('Layanan login Google tidak dapat dimuat.')), timeoutMs);
    script?.addEventListener('load', () => { clearTimeout(timer); window.google?.accounts?.oauth2 ? resolve(window.google.accounts.oauth2) : reject(new Error('Layanan OAuth Google tidak tersedia.')); }, { once: true });
    script?.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Gagal memuat layanan OAuth Google.')); }, { once: true });
  });
}
function clearAuthTimer() { if (authTimer) clearTimeout(authTimer); authTimer = null; }
async function connectGoogle(response, type) {
  clearAuthTimer();
  const button = type === 'youtube' ? youtubeConnect : driveConnect;
  if (response?.error || !response?.code) { setStatus(response?.error_description || 'Persetujuan Google tidak berhasil.', 'error'); button.textContent = type === 'youtube' ? 'Hubungkan YouTube' : 'Hubungkan Drive'; return; }
  button.textContent = 'Menghubungkan…';
  try {
    await api(type === 'youtube' ? '/api/youtube/connect' : '/api/youtube/drive/connect', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XmlHttpRequest' }, body: JSON.stringify({ code: response.code }) });
    if (type === 'youtube') youtubeConnected = true; else driveConnected = true;
    setAccount(type, true);
    setStatus(`${type === 'youtube' ? 'YouTube' : 'Google Drive'} berhasil terhubung.`, 'ok');
    await loadSettings();
  } catch (error) { setStatus(error.message, 'error'); }
  finally { button.textContent = type === 'youtube' ? 'Hubungkan YouTube' : 'Hubungkan Drive'; setAccount(type, type === 'youtube' ? youtubeConnected : driveConnected); }
}
async function loadSettings() {
  try {
    const [auto, drive, youtube] = await Promise.all([
      api('/api/youtube/auto-upload'), api('/api/youtube/drive/status'), api('/api/youtube/status')
    ]);
    youtubeConnected = Boolean(youtube.connected);
    driveConnected = Boolean(drive.connected);
    folderInput.value = auto.folderId || '';
    enabledInput.checked = Boolean(auto.enabled);
    setAccount('youtube', youtubeConnected, youtubeConnected ? 'Akun siap menerima unggahan.' : 'Hubungkan akun channel tujuan.');
    setAccount('drive', driveConnected, driveConnected ? 'Izin baca-saja aktif.' : 'Hubungkan akun pemilik folder sumber.');
    if (auto.lastVideoId) { resultLink.href = `https://www.youtube.com/watch?v=${encodeURIComponent(auto.lastVideoId)}`; resultLink.hidden = false; }
    else resultLink.hidden = true;
    const state = auto.status === 'uploaded' ? `Unggahan terakhir: ${auto.lastFileName || 'video'}${auto.lastUploadedAt ? ` · ${new Date(auto.lastUploadedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' })} WIB` : ''}.` : auto.enabled ? (auto.status === 'error' ? `Unggah terakhir gagal: ${auto.lastError || 'periksa konfigurasi server.'}` : 'Antrean aktif. Video berikutnya diproses sekitar 10.05 WIB.') : 'Otomatis belum diaktifkan.';
    setStatus(state, auto.status === 'error' ? 'error' : auto.status === 'uploaded' ? 'ok' : '');
  } catch (error) { setStatus(error.message || 'Status antrean belum dapat dimuat.', 'error'); }
}
async function initialize() {
  try {
    const [youtube, drive, oauth] = await Promise.all([api('/api/youtube/status'), api('/api/youtube/drive/status'), waitForGoogle()]);
    youtubeConnected = Boolean(youtube.connected); driveConnected = Boolean(drive.connected);
    youtubeClient = oauth.initCodeClient({ client_id: youtube.clientId, scope: 'https://www.googleapis.com/auth/youtube.upload', ux_mode: 'popup', callback: (response) => connectGoogle(response, 'youtube') });
    if (drive.configured && drive.clientId) driveClient = oauth.initCodeClient({ client_id: drive.clientId, scope: 'https://www.googleapis.com/auth/drive.readonly', include_granted_scopes: true, ux_mode: 'popup', callback: (response) => connectGoogle(response, 'drive') });
    setAccount('youtube', youtubeConnected);
    setAccount('drive', driveConnected, drive.configured ? '' : 'Integrasi Google belum dikonfigurasi di server.');
    await loadSettings();
  } catch (error) { setStatus(error.message || 'Integrasi Google belum siap.', 'error'); setAccount('youtube', false); setAccount('drive', false); }
}
function startAuthorization(type) {
  const client = type === 'youtube' ? youtubeClient : driveClient;
  if (!client || saving) return;
  const button = type === 'youtube' ? youtubeConnect : driveConnect;
  button.disabled = true; button.textContent = 'Menunggu…'; setStatus('Setujui akses di jendela Google yang terbuka…'); client.requestCode({ prompt: 'consent select_account' });
  clearAuthTimer(); authTimer = setTimeout(() => { button.textContent = type === 'youtube' ? 'Hubungkan YouTube' : 'Hubungkan Drive'; setAccount(type, type === 'youtube' ? youtubeConnected : driveConnected); setStatus('Jendela persetujuan ditutup. Tekan tombol hubungkan untuk mencoba lagi.'); }, 30000);
}
youtubeConnect.addEventListener('click', () => startAuthorization('youtube'));
driveConnect.addEventListener('click', () => startAuthorization('drive'));
async function disconnect(type) {
  const button = type === 'youtube' ? youtubeDisconnect : driveDisconnect; button.disabled = true;
  try { await api(type === 'youtube' ? '/api/youtube/connection' : '/api/youtube/drive/connection', { method: 'DELETE' }); if (type === 'youtube') youtubeConnected = false; else driveConnected = false; setAccount(type, false); setStatus(`Koneksi ${type === 'youtube' ? 'YouTube' : 'Google Drive'} telah dilepas.`); await loadSettings(); }
  catch (error) { setStatus(error.message, 'error'); } finally { button.disabled = false; }
}
youtubeDisconnect.addEventListener('click', () => disconnect('youtube'));
driveDisconnect.addEventListener('click', () => disconnect('drive'));
saveButton.addEventListener('click', async () => {
  if (saving) return;
  const enabled = enabledInput.checked;
  if (enabled && (!youtubeConnected || !driveConnected)) { setStatus('Hubungkan YouTube dan Google Drive terlebih dahulu.', 'error'); return; }
  if (enabled && !folderInput.value.trim()) { setStatus('Masukkan tautan atau ID folder Google Drive.', 'error'); return; }
  if (enabled && !window.confirm('Aktifkan upload otomatis satu video per hari sebagai Publik? Video mentah akan diproses oleh alur VideoTeks sebelum diunggah.')) { enabledInput.checked = false; return; }
  saving = true; saveButton.disabled = true; saveButton.textContent = 'Menyimpan…'; setAccount('youtube', youtubeConnected); setAccount('drive', driveConnected); setStatus('Memeriksa folder dan menyimpan antrean…');
  try { const data = await api('/api/youtube/auto-upload', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, folderId: folderInput.value.trim() }) }); folderInput.value = data.folderId || folderInput.value; enabledInput.checked = Boolean(data.enabled); setStatus(data.enabled ? `Aktif untuk folder “${data.folderName || 'Drive'}”. Satu video per hari sekitar 10.05 WIB.` : 'Pengaturan otomatis dinonaktifkan.', data.enabled ? 'ok' : ''); await loadSettings(); }
  catch (error) { setStatus(error.message || 'Pengaturan gagal disimpan.', 'error'); }
  finally { saving = false; saveButton.disabled = false; saveButton.textContent = 'Simpan pengaturan'; setAccount('youtube', youtubeConnected); setAccount('drive', driveConnected); }
});
void initialize();
