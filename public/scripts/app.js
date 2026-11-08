import { h, clear, toast } from './dom.js'
import { api, setSignedOutHandler } from './api.js'
import { state, setRender } from './state.js'
import { modals } from './modal.js'
import { closeCtx } from './ctxmenu.js'
import { pageMissing } from './layout.js'
import { pageLogin, pageInvite } from './pages/auth.js'
import { pageHome } from './pages/roadmaps.js'
import { pageRoadmap } from './pages/board.js'
import { pageTeam, pageUser, pageProfile } from './pages/account.js'
import { pageGlobalLog, pageRoadmapLog, pagePasswords } from './pages/logs.js'

const app = document.getElementById('app')

// popup menus close on any click
document.addEventListener('click', () => document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')))

function route(parts) {
  const u = state.me
  if (parts[0] === 'invite') return pageInvite(parts.slice(1).join('/'))
  if (!u) {
    if (parts[0] && parts[0] !== 'login') history.replaceState(null, '', '#/login')
    return pageLogin()
  }
  if (parts[0] === 'login' || !parts.length) return pageHome()
  if (parts[0] === 'roadmap') return pageRoadmap(parts[1])
  if (parts[0] === 'team') return pageTeam()
  if (parts[0] === 'user') return pageUser(parts[1])
  if (parts[0] === 'profile') return pageProfile()
  if (parts[0] === 'log' && parts[1] === 'roadmap') return pageRoadmapLog(parts[2])
  if (parts[0] === 'log') return pageGlobalLog()
  if (parts[0] === 'passwords') return pagePasswords()
  return pageMissing('That page doesn\'t exist.')
}

// Pages fetch their data, so a render is async. Only the newest one is shown:
// a slow response for a page you already left never replaces the current one.
let seq = 0
async function render() {
  const mine = ++seq
  closeCtx()
  if (modals.length === 0) document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'))
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean)
  let page
  try {
    page = await route(parts)
  } catch (e) {
    if (e && e.status === 401) return // the signed-out handler already re-rendered
    page = pageMissing(e && e.message ? e.message : 'Something went wrong.')
  }
  if (mine !== seq) return
  const scroll = window.scrollY
  const focusId = document.activeElement && document.activeElement.id
  document.title = page.kivoTitle || 'Kivo Office'
  clear(app); app.append(page)
  if (focusId) { const f = document.getElementById(focusId); if (f && modals.length === 0) f.focus() }
  window.scrollTo(0, scroll)
}
setRender(render)

// The session ended (expired, signed out elsewhere, deactivated).
setSignedOutHandler(() => {
  if (!state.me) return
  state.me = null
  toast('Your session ended. Please sign in again.', true)
  modals.slice().forEach((m) => m.close())
  if (!/^#\/invite\//.test(location.hash)) history.replaceState(null, '', '#/login')
  render()
})

window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render() })

async function boot() {
  try {
    const r = await api.session()
    state.me = r.user
  } catch (e) {
    state.me = null
  }
  if (!state.me && location.hash !== '#/login' && !/^#\/invite\//.test(location.hash)) history.replaceState(null, '', '#/login')
  await render()
}
boot().catch((e) => { clear(app); app.append(h('p', { class: 'page-loading', text: 'Could not start Kivo Office: ' + e.message })) })
