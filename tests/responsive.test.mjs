import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// ponytail: installed Chrome + Node 22 WebSocket, no browser dependency. Add a browser matrix when CI needs it.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' }
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, `.${decodeURIComponent(new URL(req.url, 'http://localhost').pathname)}`)
    if (!path.startsWith(root + sep) && path !== root) { res.writeHead(403).end(); return }
    const file = path === root ? join(root, 'index.html') : path
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream')
    res.end(await readFile(file))
  } catch { res.writeHead(404).end() }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`
const profile = await mkdtemp(join(process.env.JCODE_SCRATCH_DIR || tmpdir(), 'utaloom-chrome-'))
const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--disable-background-networking', '--disable-extensions', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
let socket
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000)
    chrome.once('error', reject)
    chrome.once('exit', code => { clearTimeout(timeout); reject(new Error(`Chrome exited: ${code}`)) })
    chrome.stderr.on('data', data => {
      const match = String(data).match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    })
  })
  const pages = await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json()
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl)
  await once(socket, 'open')
  let id = 0
  const pending = new Map()
  const events = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const request = pending.get(message.id)
      if (!request) return
      clearTimeout(request.timeout)
      pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    } else if (events.has(message.method)) {
      events.get(message.method)(message.params)
      events.delete(message.method)
    }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id
    // Chrome may expose DevTools before its first navigation is ready on slower machines.
    const timeout = setTimeout(() => { pending.delete(current); reject(new Error(`${method} timed out`)) }, method === 'Page.navigate' ? 60000 : 15000)
    pending.set(current, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id: current, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.text)
    return result.result.value
  }
  await send('Page.enable')
  await send('Network.enable')
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  // Deterministic API fixtures exercise the real download renderer, including maximum-length filenames.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const originalFetch = window.fetch
    window.fetch = (url, options) => {
      if (!String(url).startsWith('https://api.github.com/repos/')) return originalFetch(url, options)
      const mode = new URLSearchParams(location.search).get('test-state')
      if (mode === 'error') return Promise.resolve(new Response('{}', { status: 429 }))
      const repo = String(url).includes('utaloom-android') ? 'cabrata/utaloom-android' : 'cabrata/utaloom'
      const names = repo.endsWith('-android') ? ['Utaloom-Android-with-Google-Cast.apk'] : ['utaloom-1.0.5.msi', 'utaloom_1.0.5_amd64.deb', 'utaloom-1.0.5.x86_64.rpm', 'utaloom-' + 'x'.repeat(180) + '.msi']
      return Promise.resolve(new Response(JSON.stringify({ tag_name: 'v1.0.5', draft: false, prerelease: false, published_at: '2026-10-09T01:02:48Z', html_url: 'https://github.com/' + repo + '/releases/tag/v1.0.5', assets: mode === 'empty' ? [] : names.map(name => ({ name, size: 12345678, browser_download_url: 'https://github.com/' + repo + '/releases/download/v1.0.5/' + name })) }), { status: 200 }))
    }
  ` })
  const open = async page => {
    const loaded = new Promise(resolve => events.set('Page.loadEventFired', resolve))
    await send('Page.navigate', { url: `${base}/${page}` })
    let timeout
    try { await Promise.race([loaded, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Page load timed out')), 15000) })]) }
    finally { clearTimeout(timeout) }
  }
  const viewport = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await evaluate('window.scrollTo(0, 0); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }
  const checkLayout = async label => {
    const result = await evaluate(`(() => {
      const width = document.documentElement.clientWidth
      const visible = element => !!element.getClientRects().length
      const escaped = [...document.querySelectorAll('body *')].filter(element => {
        if (!visible(element) || element.closest('[aria-hidden="true"], .mobile-gallery, .skip-link')) return false
        const box = element.getBoundingClientRect()
        return box.left < -1 || box.right > width + 1
      }).map(element => element.tagName.toLowerCase() + '.' + element.className)
      const brand = document.querySelector('.nav .brand > span').getBoundingClientRect()
      const actions = document.querySelector('.nav-actions').getBoundingClientRect()
      const tabsUnbroken = [...document.querySelectorAll('.download-tabs button')].every(button => {
        const range = document.createRange()
        range.selectNodeContents([...button.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()))
        return range.getClientRects().length === 1
      })
      return { width, scroll: document.documentElement.scrollWidth, escaped: escaped.slice(0, 12), navigation: [...document.querySelectorAll('.nav-links a')].every(visible), headerClear: brand.right + 6 <= actions.left, tabsUnbroken }
    })()`)
    assert.ok(result.scroll <= result.width + 1, `${label}: page overflow ${JSON.stringify(result)}`)
    assert.deepEqual(result.escaped, [], `${label}: clipped or overflowing content`)
    assert.equal(result.navigation, true, `${label}: navigation unavailable`)
    assert.equal(result.headerClear, true, `${label}: brand overlaps header controls`)
    assert.equal(result.tabsUnbroken, true, `${label}: platform label wraps mid-word`)
  }
  const screenshot = async name => {
    if (!process.env.RESPONSIVE_SCREENSHOTS) return
    await mkdir(process.env.RESPONSIVE_SCREENSHOTS, { recursive: true })
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(join(process.env.RESPONSIVE_SCREENSHOTS, `${name}.png`), Buffer.from(data, 'base64'))
  }
  const sizes = [[320, 640], [360, 800], [390, 844], [414, 896], [520, 800], [521, 800], [600, 960], [640, 800], [760, 1024], [761, 1024], [768, 1024], [820, 1180], [1000, 900], [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [2560, 1440], [568, 320], [844, 390]]
  for (const page of ['index.html', 'download.html?platform=windows']) {
    await open(page)
    for (const [width, height] of sizes) {
      await viewport(width, height)
      const label = `${page} ${width}x${height}`
      await checkLayout(label)
      if (page.startsWith('index')) {
        await evaluate("document.querySelector('[data-preview-tab=android]').click()")
        await checkLayout(`${label} Android`)
        const gallery = await evaluate(`(() => {
          const gallery = document.querySelector('.mobile-gallery')
          gallery.scrollLeft = gallery.scrollWidth
          const box = gallery.getBoundingClientRect()
          const last = gallery.lastElementChild.getBoundingClientRect()
          return { reachable: last.right <= box.right + 1, count: gallery.querySelectorAll('figure').length }
        })()`)
        assert.equal(gallery.count, 3, `${label}: missing Android preview`)
        assert.equal(gallery.reachable, true, `${label}: last Android preview is unreachable`)
        await evaluate("document.querySelector('[data-preview-tab=desktop]').click()")
      } else {
        for (const platform of ['linux', 'android', 'windows']) {
          await evaluate(`document.querySelector('[data-platform=${platform}]').click()`)
          await checkLayout(`${label} ${platform}`)
          assert.ok(await evaluate('document.querySelectorAll(".asset-row").length'), `${label}: missing downloads`)
        }
      }
      if ([320, 390, 1440, 568].includes(width)) await screenshot(`${page.split('.')[0]}-${width}`)
    }
    console.log(`${page}: ${sizes.length} viewport checks passed`)
  }
  await open('index.html')
  for (const [width, height] of [[320, 640], [568, 320], [1440, 900]]) {
    await viewport(width, height)
    for (const source of ['img/m-player.webp', 'img/d-lyrics-fullscreen.png']) {
      await evaluate(`document.querySelector('[data-preview-src="${source}"]').click()`)
      await evaluate('document.querySelector("#image-preview-image").decode()')
      const modal = await evaluate(`(() => {
        const dialog = document.querySelector('dialog')
        const box = dialog.getBoundingClientRect()
        const close = document.querySelector('#close-preview').getBoundingClientRect()
        const image = document.querySelector('#image-preview-image').getBoundingClientRect()
        return { open: dialog.open, fits: box.width <= innerWidth && box.height <= innerHeight, closeVisible: close.top >= 0 && close.right <= innerWidth && close.bottom <= innerHeight, readable: innerHeight > 480 || image.width >= Math.min(240, innerWidth - 60) }
      })()`)
      assert.deepEqual(modal, { open: true, fits: true, closeVisible: true, readable: true }, `Preview ${width}x${height}`)
      await evaluate('document.querySelector("dialog").scrollTop = 1000')
      assert.ok(await evaluate('document.querySelector("#close-preview").getBoundingClientRect().top >= 0'), 'Close remains accessible while scrolling')
      await evaluate('document.querySelector("#close-preview").click()')
    }
    await evaluate('document.querySelector(".theme-toggle").click()')
    await checkLayout(`Theme ${width}x${height}`)
  }
  await send('Emulation.setTouchEmulationEnabled', { enabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
  await open('index.html')
  await checkLayout('Mobile touch')
  assert.ok(await evaluate(`['.theme-toggle', '.eyebrow-pill', '.gallery-chip', '.segmented-control button', '.nav .button'].every(selector => document.querySelector(selector).getBoundingClientRect().height >= 44)`), 'Touch targets are at least 44px')
  await evaluate('document.querySelector("#preview-desktop-tab").focus()')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight' })
  assert.equal(await evaluate('document.querySelector("#preview-android-tab").getAttribute("aria-selected")'), 'true')
  await evaluate('document.querySelector(".hero-phone button").click()')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await evaluate('new Promise(resolve => requestAnimationFrame(resolve))')
  assert.equal(await evaluate('document.querySelector("dialog").open'), false, 'Escape closes the preview')
  for (const state of ['error', 'empty']) {
    await open(`download.html?platform=android&test-state=${state}`)
    await viewport(320, 640)
    await checkLayout(`Downloads ${state}`)
    assert.equal(await evaluate('document.querySelector("#release-state").hidden'), false)
  }
  console.log('responsive.test.mjs: layout, platform tabs, Android gallery, themes, dialogs and download states passed')
} finally {
  socket?.close()
  if (chrome.exitCode === null) { chrome.kill(); await once(chrome, 'close') }
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(profile, { recursive: true, force: true })
}
