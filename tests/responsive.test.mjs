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
  const waitFor = async expression => {
    const deadline = Date.now() + 5000
    while (!await evaluate(expression)) {
      assert.ok(Date.now() < deadline, `Timed out waiting for ${expression}`)
      await evaluate('new Promise(resolve => requestAnimationFrame(resolve))')
    }
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
    await evaluate(`document.getAnimations().filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime)).forEach(animation => animation.finish())`)
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
  await send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await viewport(1440, 900)
  await open('index.html')
  await waitFor('document.querySelector(".hero h1").classList.contains("motion-enter")')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".hero h1")).animationName'), 'motion-enter', 'Hero enters progressively')
  assert.ok(await evaluate('getComputedStyle(document.querySelector(".hero-actions")).animationDelay !== getComputedStyle(document.querySelector(".hero h1")).animationDelay'), 'Hero entrance is staggered')
  await evaluate('document.querySelector(".hero-actions a").focus()')
  assert.equal(await evaluate('document.hasFocus()'), true, 'Keyboard checks run in an active tab')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".hero-actions")).opacity'), '1', 'Keyboard focus never waits for a reveal')
  await evaluate('document.activeElement.blur(); document.querySelector(".hero-showcase").scrollIntoView({ behavior: "instant", block: "center" })')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".hero-actions")).opacity'), '1', 'Leaving focus does not replay or hide settled content')
  assert.equal(await evaluate('document.querySelector(".hero-actions").getAnimations().length'), 0, 'Focused entrance is permanently finished')
  await waitFor('document.querySelector(".hero-showcase").classList.contains("motion-enter")')
  const decorations = await evaluate(`(() => {
    const tags = [...document.querySelectorAll('.floating-tag')].map(element => getComputedStyle(element))
    const bars = [...document.querySelectorAll('.mini-wave i')].map(element => getComputedStyle(element))
    return { floats: tags.every(style => style.animationName === 'gentle-float'), bars: bars.every(style => style.animationName === 'equalizer'), staggered: new Set(bars.map(style => style.animationDelay)).size > 1, bounded: [...tags, ...bars].every(style => parseFloat(style.animationDuration) * Number(style.animationIterationCount) + Math.max(0, parseFloat(style.animationDelay)) <= 5), tilt: getComputedStyle(document.querySelector('.hero-phone')).transform !== 'none' }
  })()`)
  assert.deepEqual(decorations, { floats: true, bars: true, staggered: true, bounded: true, tilt: true }, 'Decorative motion stays brief and preserves the device tilt')
  await evaluate('document.querySelector(".feature-card").scrollIntoView({ behavior: "instant", block: "center" })')
  await waitFor('document.querySelector(".feature-card").classList.contains("motion-enter")')
  await evaluate('Promise.all(document.querySelector(".feature-card").getAnimations().map(animation => animation.finished))')
  await evaluate('window.scrollTo({ top: 0, behavior: "instant" })')
  await evaluate('document.querySelector(".feature-card").scrollIntoView({ behavior: "instant", block: "center" })')
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  assert.equal(await evaluate('document.querySelector(".feature-card").getAnimations().length'), 0, 'Scrolling back does not replay the reveal')
  await evaluate('document.querySelector("#preview").scrollIntoView({ behavior: "instant", block: "start" })')
  await evaluate('document.querySelector("#preview-android-tab").click()')
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#preview-android")).animationName'), 'motion-enter', 'Platform preview transitions in')
  await evaluate('document.querySelector("#preview-desktop-tab").click(); document.querySelector("[data-gallery-name=Explore]").click()')
  await waitFor('document.querySelector("#desktop-gallery-image").complete && document.querySelector("#desktop-gallery-image").naturalWidth > 0')
  assert.ok(await evaluate('document.querySelector("#desktop-gallery-image").getAnimations().length > 0'), 'Loaded gallery screenshots fade in')
  await evaluate('document.querySelector("#desktop-gallery-image").getAnimations().forEach(animation => animation.pause())')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await waitFor('document.querySelector("#desktop-gallery-image").getAnimations().length === 0')
  assert.ok(await evaluate('[...document.querySelectorAll(".floating-tag, .mini-wave i")].every(element => getComputedStyle(element).animationName === "none")'), 'Live reduced-motion changes stop active decorations')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await evaluate('document.querySelector(".hero-phone button").click()')
  assert.equal(await evaluate('getComputedStyle(document.querySelector("dialog")).animationName'), 'dialog-enter', 'Preview dialog animates open')
  await evaluate('document.querySelector("dialog").close()')
  await screenshot('motion-desktop')

  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await open('index.html')
  assert.equal(await evaluate('getComputedStyle(document.documentElement).scrollBehavior'), 'auto', 'Reduced motion disables smooth scrolling')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".hero h1")).animationName'), 'none', 'Reduced motion disables reveals')
  await evaluate('document.querySelector(".hero-showcase").scrollIntoView({ behavior: "instant", block: "center" })')
  await waitFor('document.querySelector(".hero-showcase").classList.contains("motion-enter")')
  assert.ok(await evaluate('[...document.querySelectorAll(".floating-tag, .mini-wave i")].every(element => getComputedStyle(element).animationName === "none")'), 'Reduced motion disables decorative motion')
  await evaluate('document.querySelector("#preview").scrollIntoView({ behavior: "instant", block: "start" })')
  await evaluate('document.querySelector("#preview-android-tab").click()')
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#preview-android")).animationName'), 'none', 'Reduced motion disables tab transitions')
  await evaluate('document.querySelector("#preview-desktop-tab").click(); document.querySelector("[data-gallery-name=Search]").click()')
  await waitFor('document.querySelector("#desktop-gallery-image").complete && document.querySelector("#desktop-gallery-image").naturalWidth > 0')
  assert.equal(await evaluate('document.querySelector("#desktop-gallery-image").getAnimations().length'), 0, 'Reduced motion disables screenshot fades')
  await evaluate('document.querySelector(".hero-phone button").click()')
  assert.equal(await evaluate('getComputedStyle(document.querySelector("dialog")).animationName'), 'none', 'Reduced motion disables modal transitions')
  await evaluate('document.querySelector("dialog").close()')
  await waitFor('document.activeElement === document.querySelector(".hero-phone button")')

  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.dataset.theme = '${theme}'`)
    const contrast = await evaluate(`(() => {
      const rgb = value => value.match(/[\\d.]+/g).map(Number)
      const blend = (front, back, alpha = front[3] ?? 1) => front.slice(0, 3).map((value, i) => value * alpha + back[i] * (1 - alpha))
      const luminance = color => color.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0)
      return [...document.querySelectorAll('.hero-description, .button-primary, .button-dark, .platform-line a, .feature-card p, .card-kicker, .card-footnote, .section-heading p, .source-copy p, .license-note, .cta-footnote, .footer-bottom')].filter(element => element.getClientRects().length).map(element => {
        const ancestors = []
        for (let node = element; node; node = node.parentElement) ancestors.unshift(node)
        const background = ancestors.reduce((color, node) => blend(rgb(getComputedStyle(node).backgroundColor), color), [255, 255, 255])
        const style = getComputedStyle(element)
        const foreground = blend(rgb(style.color), background, Number(style.opacity))
        const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b)
        return { selector: element.className || element.tagName, ratio: (values[1] + .05) / (values[0] + .05) }
      })
    })()`)
    assert.deepEqual(contrast.filter(item => item.ratio < 4.5), [], `${theme}: normal text contrast must reach 4.5:1`)
    await viewport(1440, 900)
    await screenshot(`polished-hero-${theme}`)
    for (const section of ['features', 'preview', 'open-source']) {
      await evaluate(`document.getElementById('${section}').scrollIntoView({ behavior: 'instant', block: 'start' })`)
      await waitFor(`document.querySelector('.nav-links a[aria-current="location"]')?.getAttribute('href') === '#${section}'`)
      await checkLayout(`${theme} ${section}`)
      await screenshot(`polished-${section}-${theme}`)
    }
    await evaluate('document.querySelector(".final-cta").scrollIntoView({ behavior: "instant", block: "center" })')
    await screenshot(`polished-cta-${theme}`)
  }
  await evaluate('document.documentElement.dataset.theme = "light"')
  await viewport(390, 844)
  await screenshot('polished-mobile')

  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await send('Emulation.setScriptExecutionDisabled', { value: true })
  try {
    await open('index.html')
    assert.ok(await evaluate('[...document.querySelectorAll(".hero h1, .feature-card, .open-source-card")].every(element => getComputedStyle(element).opacity === "1" && element.getClientRects().length > 0)'), 'Content stays visible without JavaScript')
  } finally { await send('Emulation.setScriptExecutionDisabled', { value: false }) }
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'delete window.IntersectionObserver' })
  await open('index.html')
  assert.ok(await evaluate('getComputedStyle(document.querySelector(".hero h1")).opacity === "1" && !document.querySelector(".motion-enter")'), 'Unsupported IntersectionObserver keeps content visible')
  const previousTheme = await evaluate('document.documentElement.dataset.theme')
  await evaluate('document.querySelector(".theme-toggle").click()')
  assert.notEqual(await evaluate('document.documentElement.dataset.theme'), previousTheme, 'Fallback keeps existing interactions working')
  console.log('responsive.test.mjs: layouts, tabs, gallery, themes, contrast, section navigation, dialog focus, download states, motion, reduced motion and progressive fallbacks passed')
} finally {
  socket?.close()
  if (chrome.exitCode === null) { chrome.kill(); await once(chrome, 'close') }
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(profile, { recursive: true, force: true })
}
