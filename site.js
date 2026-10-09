const root = document.documentElement
const themeButton = document.querySelector('.theme-toggle')
function setTheme(theme) {
  root.dataset.theme = theme
  themeButton?.setAttribute('aria-label', `Aktifkan tema ${theme === 'dark' ? 'terang' : 'gelap'}`)
  themeButton?.setAttribute('aria-pressed', String(theme === 'dark'))
  themeButton?.querySelector('use').setAttribute('href', `img/icons.svg#${theme === 'dark' ? 'sun' : 'moon'}`)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#19181c' : '#faf8f5')
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
document.querySelectorAll('[data-preview-src]').forEach(button => button.addEventListener('click', () => {
  if (!dialog) return
  const image = document.getElementById('image-preview-image')
  image.src = button.dataset.previewSrc
  image.alt = button.dataset.previewTitle
  document.getElementById('image-preview-title').textContent = button.dataset.previewTitle
  dialog.showModal()
}))
document.getElementById('close-preview')?.addEventListener('click', () => dialog.close())
dialog?.addEventListener('click', event => {
  const box = dialog.getBoundingClientRect()
  if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close()
})
