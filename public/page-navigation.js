const FEATURE_ROUTES = {
  'app.html': 'app',
  'audio.html': 'audio',
  'voice.html': 'voice',
  'youtube.html': 'youtube',
  'drive-auto-upload.html': 'driveAutoUpload',
  'history.html': 'history'
};
const SHELL_ROUTES = {
  ...FEATURE_ROUTES,
  'privacy.html': 'privacy',
  'terms.html': 'terms',
  'delete-account.html': 'delete',
  'index.html': 'app'
};
const APP_BASE = new URL('./', document.currentScript?.src || location.href);

function routeFromUrl(url) {
  if (url.origin !== APP_BASE.origin || !url.pathname.startsWith(APP_BASE.pathname)) return null;
  return SHELL_ROUTES[url.pathname.split('/').pop() || 'index.html'] || null;
}

// Direct links to a feature join the persistent shell before the feature script starts.
if (window.parent === window) {
  const current = new URL(location.href);
  const route = current.pathname.startsWith(APP_BASE.pathname) ? FEATURE_ROUTES[current.pathname.split('/').pop()] : null;
  if (route && current.searchParams.get('standalone') !== '1') {
    const shell = new URL('studio.html', current);
    shell.search = '';
    shell.searchParams.set('view', route);
    for (const [key, value] of current.searchParams.entries()) shell.searchParams.append(key, value);
    shell.hash = current.hash;
    location.replace(shell.href);
  }
}

document.addEventListener('click', (event) => {
  if (window.parent === window) return;
  const target = event.target;
  const link = target instanceof Element ? target.closest('a[href]') : null;
  if (!link || event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (link.hasAttribute('download') || (link.target && link.target !== '_self')) return;

  const destination = new URL(link.href, location.href);
  if (destination.origin !== location.origin) return;
  // Keep same-document fragment links native so they scroll to their section.
  if (destination.pathname === location.pathname && destination.search === location.search && destination.hash !== location.hash) return;
  const route = routeFromUrl(destination);
  if (!route) return;
  event.preventDefault();
  if (destination.href === location.href) return;
  window.parent.postMessage({ source: 'videoteks-feature', type: 'navigate', href: destination.href }, location.origin);
});

window.addEventListener('pageshow', () => {
  document.body.classList.remove('page-loading');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const hadController = Boolean(navigator.serviceWorker.controller);
    if (hadController) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        const hasSelectedFile = [...document.querySelectorAll('input[type="file"]')].some((input) => input.files?.length);
        const hasEditedField = [...document.querySelectorAll('input, textarea, select')].some((field) => {
          if (field.disabled || field.hidden || field.type === 'hidden' || field.closest('[hidden]')) return false;
          if (field.type === 'checkbox' || field.type === 'radio') return field.checked !== field.defaultChecked;
          if (field instanceof HTMLSelectElement) return [...field.options].some((option) => option.selected !== option.defaultSelected);
          return field.value !== field.defaultValue;
        });
        if (!hasSelectedFile && !hasEditedField && !document.querySelector('.progress:not([hidden])')) location.reload();
      }, { once: true });
    }
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((registration) => {
      const checkForUpdate = () => {
        if (document.visibilityState === 'visible') void registration.update().catch(() => {});
      };
      void registration.update().catch(() => {});
      document.addEventListener('visibilitychange', checkForUpdate);
    }).catch(() => {});
  });
}
