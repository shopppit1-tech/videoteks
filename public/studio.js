import { waitForUser } from './firebase-client.js';

const APP_BASE = new URL('./', import.meta.url);
const ROUTES = {
  app: { file: 'app.html', title: 'Subtitle Video' },
  audio: { file: 'audio.html', title: 'Ganti Audio' },
  voice: { file: 'voice.html', title: 'Suara AI' },
  youtube: { file: 'youtube.html', title: 'Upload YouTube' },
  driveAutoUpload: { file: 'drive-auto-upload.html', title: 'Google Drive ke YouTube' },
  history: { file: 'history.html', title: 'Riwayat' },
  animasi: { file: 'animasi.html', title: 'Animasi AI' },
  privacy: { file: 'privacy.html', title: 'Kebijakan Privasi' },
  terms: { file: 'terms.html', title: 'Syarat Penggunaan' },
  delete: { file: 'delete-account.html', title: 'Hapus akun' }
};
const ROUTE_BY_FILE = Object.fromEntries(Object.entries(ROUTES).map(([route, page]) => [page.file, route]));
ROUTE_BY_FILE['index.html'] = 'app';
const screenHost = document.querySelector('#screenHost');
const boot = document.querySelector('#shellBoot');
const frames = new Map();
let pendingRoute = null;

function routeForUrl(url) {
  if (url.origin !== APP_BASE.origin || !url.pathname.startsWith(APP_BASE.pathname)) return null;
  const file = url.pathname.split('/').pop() || 'index.html';
  return ROUTE_BY_FILE[file] || null;
}

function shellUrl(route, params, hash = '') {
  const target = new URL('studio.html', APP_BASE);
  target.searchParams.set('view', route);
  for (const [key, value] of params.entries()) {
    if (key !== 'view') target.searchParams.append(key, value);
  }
  target.hash = hash;
  return target;
}

function showRoute(route) {
  const activeFrame = frames.get(route);
  if (!activeFrame || activeFrame.dataset.ready !== 'true') {
    pendingRoute = route;
    return;
  }
  for (const [name, frame] of frames.entries()) {
    const active = name === route;
    frame.hidden = !active;
    frame.setAttribute('aria-hidden', String(!active));
    if (!active && frame.dataset.ready === 'true') {
      try {
        frame.contentDocument.querySelectorAll('video,audio').forEach((media) => media.pause());
      } catch { /* frame same-origin; skip if it is unloading */ }
    }
  }
  pendingRoute = null;
  boot.hidden = true;
  document.title = `${ROUTES[route].title} — VideoTeks`;
}

function sendHandoff(route, frame) {
  const type = route === 'audio' ? 'load-generated-audio' : route === 'app' ? 'load-generated-video' : null;
  if (type && frame.dataset.ready === 'true') {
    frame.contentWindow.postMessage({ source: 'videoteks-shell', type }, location.origin);
  }
}

function navigate(route, params = new URLSearchParams(), { writeHistory = false, replaceHistory = false, hash = '', handoff = false } = {}) {
  if (!ROUTES[route]) route = 'app';
  const cleanParams = new URLSearchParams(params);
  cleanParams.delete('view');

  if (route === 'app' || route === 'audio' || route === 'voice') {
    const standaloneUrl = new URL(ROUTES[route].file, APP_BASE);
    for (const [key, value] of cleanParams.entries()) standaloneUrl.searchParams.append(key, value);
    standaloneUrl.searchParams.set('standalone', '1');
    standaloneUrl.hash = hash;
    location.replace(standaloneUrl.href);
    return;
  }

  if (writeHistory) {
    const url = shellUrl(route, cleanParams, hash);
    const method = replaceHistory ? 'replaceState' : 'pushState';
    history[method]({ route }, '', `${url.pathname}${url.search}${url.hash}`);
  }

  let frame = frames.get(route);
  if (frame) {
    try { frame.contentWindow.location.hash = hash; } catch { /* retain current in-frame position */ }
    showRoute(route);
    if (handoff) {
      if (frame.dataset.ready === 'true') sendHandoff(route, frame);
      else frame.dataset.pendingHandoff = 'true';
    }
    return;
  }

  frame = document.createElement('iframe');
  frame.title = ROUTES[route].title;
  frame.hidden = true;
  frame.loading = 'eager';
  frame.allow = 'autoplay; clipboard-write';
  frame.setAttribute('scrolling', 'yes');
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.addEventListener('load', () => {
    frame.dataset.ready = 'true';
    if (pendingRoute === route) showRoute(route);
    if (frame.dataset.pendingHandoff === 'true') {
      delete frame.dataset.pendingHandoff;
      sendHandoff(route, frame);
    }
  }, { once: true });

  const frameUrl = new URL(ROUTES[route].file, APP_BASE);
  for (const [key, value] of cleanParams.entries()) frameUrl.searchParams.append(key, value);
  frameUrl.hash = hash;
  frame.src = frameUrl.href;
  frames.set(route, frame);
  screenHost.append(frame);
  pendingRoute = route;
}

function restoreFromLocation() {
  const params = new URLSearchParams(location.search);
  const requested = params.get('view') || 'app';
  const route = ROUTES[requested] ? requested : 'app';
  params.delete('view');
  if (route !== requested) {
    const normalized = shellUrl(route, params, location.hash);
    history.replaceState({ route }, '', `${normalized.pathname}${normalized.search}${normalized.hash}`);
  }
  navigate(route, params, { hash: location.hash });
}

function redirectToLogin() {
  const next = new URL('studio.html', APP_BASE);
  next.search = location.search;
  next.hash = location.hash;
  const login = new URL('index.html', APP_BASE);
  login.searchParams.set('next', `${next.pathname}${next.search}${next.hash}`);
  location.replace(login.href);
}

window.addEventListener('popstate', restoreFromLocation);
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || !event.data || event.data.source !== 'videoteks-feature') return;
  const sourceFrame = [...frames.values()].find((frame) => frame.contentWindow === event.source);
  if (!sourceFrame) return;

  if (event.data.type === 'signed-out') {
    location.replace(new URL('index.html', APP_BASE).href);
    return;
  }
  if (event.data.type === 'auth-required') {
    redirectToLogin();
    return;
  }
  if (event.data.type !== 'navigate' || typeof event.data.href !== 'string') return;

  const destination = new URL(event.data.href, location.href);
  if (destination.origin !== location.origin) return;
  const route = routeForUrl(destination);
  if (!route) return;
  const params = new URLSearchParams(destination.search);
  navigate(route, params, {
    writeHistory: true,
    hash: destination.hash,
    handoff: params.get('generated') === '1'
  });
});

async function start() {
  try {
    const user = await waitForUser();
    if (!user) {
      redirectToLogin();
      return;
    }
    restoreFromLocation();
  } catch {
    const message = boot.querySelector('.boot-name');
    message.textContent = 'Tidak dapat membuka studio. Periksa koneksi lalu coba lagi.';
  }
}

void start();
