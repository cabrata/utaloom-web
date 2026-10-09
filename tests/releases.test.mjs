import assert from 'node:assert/strict';
import { choosePlatform, classifyAsset, fetchRelease, parseRelease, releaseView, safeAssetUrl } from '../releases.js';

const D = 'cabrata/utaloom';
const A = 'cabrata/utaloom-android';
const dl = (repo, tag, name) => `https://github.com/${repo}/releases/download/${tag}/${name}`;
const release = (repo, tag, names, extra = {}) => ({
  tag_name: tag, draft: false, prerelease: false, published_at: '2026-10-09T01:02:48Z',
  html_url: `https://github.com/${repo}/releases/tag/${tag}`,
  assets: names.map((name) => ({ name, size: 1024, browser_download_url: dl(repo, tag, name) })), ...extra,
});

// Real filenames from current releases plus supported formats.
const cases = {
  'utaloom-1.0.5.msi': ['windows', 'MSI installer', null],
  'Utaloom_1.0.5_x64-setup.exe': ['windows', 'EXE installer', 'x64'],
  'utaloom_1.0.5_amd64.deb': ['linux', 'DEB package', 'x64'],
  'utaloom-1.0.5-1.x86_64.rpm': ['linux', 'RPM package', 'x64'],
  'Utaloom_1.0.5_aarch64.AppImage': ['linux', 'AppImage', 'ARM64'],
  'utaloom-linux-x64.tar.gz': ['linux', 'TAR.GZ archive', 'x64'],
  'utaloom-linux-arm64.zip': ['linux', 'ZIP archive', 'ARM64'],
  'utaloom-windows-x64.zip': ['windows', 'ZIP archive', 'x64'],
  'Utaloom-Android.apk': ['android', 'APK', null],
  'Utaloom-Android-with-Google-Cast.apk': ['android', 'APK with Google Cast', null],
};
for (const [name, [platform, label, arch]] of Object.entries(cases)) assert.deepEqual(classifyAsset(name), { platform, label, arch }, name);
for (const name of ['utaloom.dmg', 'utaloom-macos.zip', 'utaloom-darwin.tar.gz', 'latest.json', 'checksums.txt']) assert.equal(classifyAsset(name), null, name);

// Only the exact HTTPS GitHub release download prefix is accepted.
const good = dl(D, 'v1.0.5', 'utaloom-1.0.5.msi');
assert.equal(safeAssetUrl(good, D, 'v1.0.5'), good);
for (const bad of [
  'http://github.com/cabrata/utaloom/releases/download/v1.0.5/a.msi',
  'https://user:pass@github.com/cabrata/utaloom/releases/download/v1.0.5/a.msi',
  'https://github.com:444/cabrata/utaloom/releases/download/v1.0.5/a.msi',
  'https://github.com.evil.test/cabrata/utaloom/releases/download/v1.0.5/a.msi',
  'https://evil.test/cabrata/utaloom/releases/download/v1.0.5/a.msi',
  'https://github.com/cabrata/other/releases/download/v1.0.5/a.msi',
  'https://github.com/cabrata/utaloom/releases/download/v9/a.msi',
  'https://github.com/cabrata/utaloom/releases/download/v1.0.5/../../x.msi',
  'https://github.com/cabrata/utaloom/releases/download/v1.0.5/a.msi?x=1',
  'https://github.com/cabrata/utaloom/releases/download/v1.0.5/a/b.msi',
  'javascript:alert(1)', null, 42,
]) assert.equal(safeAssetUrl(bad, D, 'v1.0.5'), null, String(bad));

// Desktop's old APK is ignored, Android comes only from its own repo.
const desktop = parseRelease(release(D, 'v1.0.5', ['utaloom-1.0.5-1.x86_64.rpm', 'utaloom-1.0.5.msi', 'utaloom-v1.0.5-android.apk', 'utaloom_1.0.5_amd64.deb']), D);
const android = parseRelease(release(A, 'v1.0.0', ['Utaloom-Android-with-Google-Cast.apk', 'Utaloom-Android.apk']), A);
assert.deepEqual(desktop.assets.map((a) => a.platform).sort(), ['linux', 'linux', 'windows']);
assert.equal(android.assets.length, 2);
assert.equal(desktop.url, 'https://github.com/cabrata/utaloom/releases/tag/v1.0.5');
const results = { [D]: { release: desktop }, [A]: { release: android } };
assert.equal(releaseView('android', results).assets.map((a) => a.name).join(), 'Utaloom-Android-with-Google-Cast.apk,Utaloom-Android.apk');
assert.equal(releaseView('windows', results).assets[0].name, 'utaloom-1.0.5.msi');
assert.equal(releaseView('linux', results).state, 'ready');

// Untrusted payloads: drafts/prereleases/bad tags rejected, hostile assets dropped, notes URL not trusted.
assert.equal(parseRelease(release(D, 'v1', [], { draft: true }), D), null);
assert.equal(parseRelease(release(D, 'v1', [], { prerelease: true }), D), null);
assert.equal(parseRelease(release(D, '<img src=x>', []), D), null);
assert.equal(parseRelease(null, D), null);
const hostile = parseRelease({ ...release(D, 'v2', []), html_url: 'https://evil.test', published_at: 'nope', assets: [
  { name: '<b>x</b>.msi', size: -1, browser_download_url: dl(D, 'v2', 'x.msi') },
  { name: 'y.exe', browser_download_url: 'https://evil.test/y.exe' }, null, { name: 7 }, 'junk',
] }, D);
assert.deepEqual(hostile.assets.map((a) => [a.name, a.size]), [['<b>x</b>.msi', null]]); // text is rendered via textContent
assert.equal(hostile.url, 'https://github.com/cabrata/utaloom/releases/latest');
assert.equal(hostile.date, null);
assert.equal(parseRelease({ ...release(D, 'v3', []), assets: 'nope' }, D).assets.length, 0);

// No assets / missing release / per-repo errors show empty or error state, never fabricated links.
const empty = { [D]: { release: parseRelease(release(D, 'v4', []), D) }, [A]: { error: new Error('GitHub rate limit reached.') } };
assert.equal(releaseView('windows', empty).state, 'empty');
assert.equal(releaseView('windows', empty).assets, undefined);
assert.equal(releaseView('android', empty).state, 'error');
assert.equal(releaseView('linux', { [D]: { release: null } }).state, 'empty');
assert.equal(releaseView('android', {}).state, 'loading');

// Fetch maps HTTP/network failures and returns null for "no release yet".
const res = (status, body, headers = {}) => async () => ({ status, ok: status < 300, headers: new Headers(headers), json: async () => body });
assert.equal((await fetchRelease(A, { fetch: res(200, release(A, 'v1.0.0', ['Utaloom-Android.apk'])) })).assets.length, 1);
assert.equal(await fetchRelease(A, { fetch: res(404) }), null);
await assert.rejects(fetchRelease(D, { fetch: res(403, {}, { 'x-ratelimit-remaining': '0' }) }), /rate limit/);
await assert.rejects(fetchRelease(D, { fetch: res(500) }), /HTTP 500/);
await assert.rejects(fetchRelease(D, { fetch: async () => { throw new TypeError('offline'); } }), /Network error/);
const keepAlive = setTimeout(() => {}, 1000); // AbortSignal.timeout timers are unref'd in Node
await assert.rejects(fetchRelease(D, { fetch: (_, { signal }) => new Promise((_, no) => signal.addEventListener('abort', () => no(signal.reason))), timeout: 5 }), /too long/);
clearTimeout(keepAlive);

// Platform choice: valid query wins, then user agent, default Windows.
assert.equal(choosePlatform('?platform=linux', 'Android'), 'linux');
assert.equal(choosePlatform('?platform=__proto__', 'Mozilla/5.0 (Linux; Android 14)'), 'android');
assert.equal(choosePlatform('', 'Mozilla/5.0 (X11; Linux x86_64)'), 'linux');
assert.equal(choosePlatform('', 'Mozilla/5.0 (Macintosh)'), 'windows');

console.log('releases.test.mjs: ok');
