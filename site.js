const root = document.documentElement
// ponytail: one-shot reveals stay visible without JS. Add scroll choreography only if the design needs it.
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    let order = 0
    entries.forEach(entry => {
      if (!entry.isIntersecting) return
      observer.unobserve(entry.target)
      if (entry.target.matches(':focus-within')) return
      entry.target.style.setProperty('--motion-delay', `${Math.min(order++, 4) * 65}ms`)
      entry.target.classList.add('motion-enter')
    })
  }, { threshold: 0.08 })
  document.querySelectorAll('.hero-copy > *, .hero-showcase, .intro-band .container, .section-heading, .feature-card, .preview-tabs, .open-source-card, .final-cta > *, .download-hero > *, .download-layout > *, .download-faq details').forEach(element => observer.observe(element))
  document.addEventListener('focusin', event => event.target.closest('.motion-enter')?.style.setProperty('animation', 'none'))
}

// Section links follow reading position without a scroll listener or a custom router.
if ('IntersectionObserver' in window) {
  const sectionObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return
      document.querySelectorAll('.nav-links a').forEach(link => {
        if (link.getAttribute('href') === `#${entry.target.id}`) link.setAttribute('aria-current', 'location')
        else link.removeAttribute('aria-current')
      })
    })
  }, { rootMargin: '-15% 0px -55% 0px', threshold: 0 })
  document.querySelectorAll('.hero, #features, #preview, #open-source, .final-cta').forEach(section => sectionObserver.observe(section))
}

const themeButton = document.querySelector('.theme-toggle')
function setTheme(theme) {
  root.dataset.theme = theme
  themeButton?.setAttribute('aria-label', `Aktifkan tema ${theme === 'dark' ? 'terang' : 'gelap'}`)
  themeButton?.setAttribute('aria-pressed', String(theme === 'dark'))
  themeButton?.querySelector('use').setAttribute('href', `img/icons.svg#${theme === 'dark' ? 'sun' : 'moon'}`)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#19181c' : '#f8f6f1')
}
try { setTheme(localStorage.getItem('utaloom-theme') === 'dark' ? 'dark' : 'light') } catch { setTheme('light') }
themeButton?.addEventListener('click', () => {
  const theme = root.dataset.theme === 'dark' ? 'light' : 'dark'
  setTheme(theme)
  try { localStorage.setItem('utaloom-theme', theme) } catch { /* The toggle still works when storage is disabled. */ }
})

const previewTabs = [...document.querySelectorAll('[data-preview-tab]')]
function selectPreview(tab) {
  previewTabs.forEach(item => {
    const active = item === tab
    item.setAttribute('aria-selected', String(active))
    item.tabIndex = active ? 0 : -1
    document.getElementById(item.getAttribute('aria-controls')).hidden = !active
  })
}
previewTabs.forEach(tab => tab.addEventListener('click', () => selectPreview(tab)))
document.querySelectorAll('[role="tablist"]').forEach(list => list.addEventListener('keydown', event => {
  const tabs = [...list.querySelectorAll('[role="tab"]')]
  const index = tabs.indexOf(document.activeElement)
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[next].focus()
  tabs[next].click()
}))

const galleryImage = document.getElementById('desktop-gallery-image')
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
reducedMotion.addEventListener('change', event => {
  if (event.matches) galleryImage?.getAnimations().forEach(animation => animation.cancel())
})
galleryImage?.addEventListener('load', () => {
  if (reducedMotion.matches) return
  galleryImage.getAnimations().forEach(animation => animation.cancel())
  galleryImage.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' })
})
document.querySelectorAll('[data-gallery-src]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-gallery-src]').forEach(item => item.setAttribute('aria-pressed', String(item === button)))
  const image = document.getElementById('desktop-gallery-image')
  image.src = button.dataset.gallerySrc
  image.alt = `Tampilan ${button.dataset.galleryName} Utaloom desktop`
  document.getElementById('desktop-view-name').textContent = button.dataset.galleryName
  const opener = document.getElementById('desktop-gallery-open')
  opener.dataset.previewSrc = image.src
  opener.dataset.previewTitle = image.alt
}))

const dialog = document.getElementById('image-preview')
let previewOpener
document.querySelectorAll('[data-preview-src]').forEach(button => button.addEventListener('click', () => {
  if (!dialog) return
  previewOpener = button
  const image = document.getElementById('image-preview-image')
  image.src = button.dataset.previewSrc
  image.alt = button.dataset.previewTitle
  document.getElementById('image-preview-title').textContent = button.dataset.previewTitle
  dialog.showModal()
}))
dialog?.addEventListener('close', () => previewOpener?.focus({ preventScroll: true }))
document.getElementById('close-preview')?.addEventListener('click', () => dialog.close())
dialog?.addEventListener('click', event => {
  const box = dialog.getBoundingClientRect()
  if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close()
})
