// Live download links from the latest stable GitHub releases. Release payloads are untrusted.
const DESKTOP = 'cabrata/utaloom';
const ANDROID = 'cabrata/utaloom-android';

export const platformSpecs = {
  windows: { label: 'Windows', repo: DESKTOP },
  linux: { label: 'Linux', repo: DESKTOP },
  android: { label: 'Android', repo: ANDROID },
};

const latestPage = (repo) => `https://github.com/${repo}/releases/latest`;

export function classifyAsset(name) {
  const n = name.toLowerCase();
  const archive = n.endsWith('.zip') || n.endsWith('.tar.gz');
  let platform = null;
  let label = null;
  if (n.endsWith('.apk')) [platform, label] = ['android', /google[-_ ]?cast/.test(n) ? 'APK with Google Cast' : 'APK'];
  else if (n.endsWith('.msi')) [platform, label] = ['windows', 'MSI installer'];
  else if (n.endsWith('.exe')) [platform, label] = ['windows', 'EXE installer'];
  else if (n.endsWith('.deb')) [platform, label] = ['linux', 'DEB package'];
  else if (n.endsWith('.rpm')) [platform, label] = ['linux', 'RPM package'];
  else if (n.endsWith('.appimage')) [platform, label] = ['linux', 'AppImage'];
  else if (archive && !/mac|darwin|osx/.test(n)) {
    // Archives without an OS hint follow convention: .zip is Windows, .tar.gz is Linux.
    const win = /windows|win(32|64)|(^|[-_.])win([-_.]|$)/.test(n) || (!/linux/.test(n) && n.endsWith('.zip'));
    [platform, label] = [win ? 'windows' : 'linux', n.endsWith('.zip') ? 'ZIP archive' : 'TAR.GZ archive'];
  }
  if (!platform) return null;
  const arch = /x86_64|amd64|x64/.test(n) ? 'x64' : /aarch64|arm64/.test(n) ? 'ARM64'
    : /armv7|armhf/.test(n) ? 'ARMv7' : /i[36]86|(^|[^_])x86([^_]|$)/.test(n) ? 'x86' : null;
  return { platform, label, arch };
}

// Exact https://github.com/<repo>/releases/download/<tag>/<file>, nothing else (no creds, port, query, traversal).
export function safeAssetUrl(url, repo, tag) {
  const prefix = `https://github.com/${repo}/releases/download/${tag}/`;
  try {
    return typeof url === 'string' && url.startsWith(prefix) && new URL(url).href === url
      && /^[^/?#\\]+$/.test(url.slice(prefix.length)) ? url : null;
  } catch { return null; }
}

export function parseRelease(data, repo) {
  if (!data || typeof data !== 'object' || data.draft !== false || data.prerelease !== false) return null;
  const tag = data.tag_name;
  if (typeof tag !== 'string' || !/^[\w.+-]{1,64}$/.test(tag)) return null;
  const date = new Date(data.published_at);
  const notes = `https://github.com/${repo}/releases/tag/${tag}`;
  const assets = (Array.isArray(data.assets) ? data.assets : []).flatMap((a) => {
    if (!a || typeof a.name !== 'string' || a.name.length > 200) return [];
    const kind = classifyAsset(a.name);
    const url = safeAssetUrl(a.browser_download_url, repo, tag);
    if (!kind || !url || platformSpecs[kind.platform].repo !== repo) return [];
    return [{ ...kind, name: a.name, url, size: Number.isSafeInteger(a.size) && a.size > 0 ? a.size : null }];
  });
  return { repo, tag, assets, date: isNaN(date) ? null : date, url: data.html_url === notes ? notes : latestPage(repo) };
}

export async function fetchRelease(repo, { fetch = globalThis.fetch, timeout = 10000 } = {}) {
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Error(e?.name === 'TimeoutError' ? 'GitHub took too long to respond (timeout).' : 'Could not reach GitHub (network error).');
  }
  if (res.status === 404) return null; // no stable release published yet
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    throw new Error('GitHub rate limit reached. Try again in a few minutes.');
  }
  if (!res.ok) throw new Error(`GitHub returned an error (HTTP ${res.status}).`);
  let data;
  try { data = await res.json(); } catch { throw new Error('The GitHub response could not be read.'); }
  return parseRelease(data, repo);
}

// Pure view model so rendering decisions are testable. results: { [repo]: { release } | { error } }.
export function releaseView(platform, results) {
  const { label, repo } = platformSpecs[platform];
  const r = results[repo];
  if (!r) return { state: 'loading', message: `Fetching the latest ${label} release…` };
  if (r.error) return { state: 'error', message: `The ${label} download could not be loaded. ${r.error.message}` };
  if (!r.release) return { state: 'empty', message: `No stable ${label} release yet.` };
  const assets = r.release.assets.filter((a) => a.platform === platform);
  if (!assets.length) {
    return { state: 'empty', release: r.release, message: `${r.release.tag} has no ${label} files yet. Check the release notes for other options.` };
  }
  return { state: 'ready', release: r.release, assets,
    message: `${assets.length} ${label} file${assets.length === 1 ? '' : 's'} available for ${r.release.tag}.` };
}

export function choosePlatform(search = '', ua = '') {
  const q = new URLSearchParams(search).get('platform');
  if (Object.hasOwn(platformSpecs, q)) return q;
  return /android/i.test(ua) ? 'android' : /linux|x11/i.test(ua) ? 'linux' : 'windows';
}

const formatSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function downloadIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const path = document.createElementNS(ns, 'path');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  path.setAttribute('d', 'M12 3v12m-5-5 5 5 5-5M5 21h14');
  for (const [k, v] of [['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) path.setAttribute(k, v);
  svg.append(path);
  return svg;
}

function assetRow(a) {
  const row = el('div', 'asset-row');
  const info = el('div', 'asset-info');
  info.append(el('span', 'asset-title', a.label), el('span', 'asset-detail', [a.name, a.size && formatSize(a.size), a.arch].filter(Boolean).join(' · ')));
  const link = el('a', 'button button-primary button-small');
  link.href = a.url;
  link.setAttribute('aria-label', `Download ${a.label} (${a.name})`);
  link.append(downloadIcon(), document.createTextNode('Download'));
  row.append(info, link);
  return row;
}

function init() {
  const root = document.querySelector('[data-downloads]');
  if (!root) return;
  const $ = (s) => root.querySelector(s) || document.querySelector(s);
  const tabs = [...root.querySelectorAll('[data-platform]')];
  const list = $('#download-assets');
  const meta = $('#release-meta');
  const notes = $('#release-link');
  const stateBox = $('#release-state');
  const retry = $('#retry-releases');
  const fallback = list ? [...list.childNodes].map((n) => n.cloneNode(true)) : [];
  const results = {};
  let platform = choosePlatform(location.search, navigator.userAgent);

  function render() {
    const view = releaseView(platform, results);
    const { repo } = platformSpecs[platform];
    for (const tab of tabs) {
      const on = tab.dataset.platform === platform;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && tab.id) $('#download-panel')?.setAttribute('aria-labelledby', tab.id);
    }
    document.querySelectorAll('[data-install-platform]').forEach((b) => { b.hidden = b.dataset.installPlatform !== platform; });
    document.querySelectorAll('[data-release-source]').forEach((s) => { s.textContent = repo; });
    document.querySelectorAll('[data-release-status]').forEach((s) => { s.textContent = view.message; });
    list?.replaceChildren(...(view.assets ? view.assets.map(assetRow) : fallback.map((n) => n.cloneNode(true))));
    list?.setAttribute('aria-busy', String(view.state === 'loading'));
    if (stateBox) { stateBox.hidden = view.state === 'ready'; stateBox.textContent = view.message; }
    if (retry) retry.hidden = !Object.values(results).some((r) => r.error);
    if (notes) notes.href = view.release?.url || latestPage(repo);
    if (meta) {
      const r = view.release;
      const parts = [];
      if (r) parts.push(`Version ${r.tag} · `);
      if (r?.date) {
        const time = el('time', null, r.date.toLocaleDateString('en-US', { dateStyle: 'medium' }));
        time.dateTime = r.date.toISOString();
        parts.push('Released ', time, ' · ');
      }
      meta.replaceChildren(...parts, `Source: ${repo}`);
    }
  }

  // Each repo loads independently so one failure never blocks the other platform.
  function load(repo) {
    delete results[repo];
    render();
    fetchRelease(repo).then((release) => { results[repo] = { release }; }, (error) => { results[repo] = { error }; }).then(render);
  }

  function select(next) {
    platform = next;
    const url = new URL(location.href);
    url.searchParams.set('platform', next);
    history.replaceState(history.state, '', url);
    render();
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab.dataset.platform));
  }
  retry?.addEventListener('click', () => Object.keys(results).filter((r) => results[r].error).forEach(load));
  [DESKTOP, ANDROID].forEach(load);
}

if (typeof document !== 'undefined') init();
