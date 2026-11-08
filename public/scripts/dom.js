// Builds DOM with h() only. User text always goes in as text nodes or
// textContent, never as HTML. Styles go through element.style (CSSOM),
// which the Content-Security-Policy allows; a style="" attribute it doesn't.

export const STATUSES = ['planned', 'in_progress', 'finished']
export const STATUS_LABEL = { planned: 'Planned', in_progress: 'In progress', finished: 'Finished' }
export const ROLE_LABEL = { it: 'IT admin', manager: 'Manager', member: 'Team member' }
export const PRESENCE = ['available', 'busy', 'away']
export const PRESENCE_LABEL = { available: 'Available', busy: 'Busy', away: 'Away' }

const PROPS = ['value', 'checked', 'disabled', 'hidden', 'draggable', 'selected']
export function h(tag, props, ...kids) {
  const e = document.createElement(tag)
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k]
      if (v == null || v === false) continue
      if (k === 'class') e.className = v
      else if (k === 'text') e.textContent = v
      else if (k === 'style') Object.assign(e.style, v)
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v)
      else if (PROPS.includes(k)) e[k] = v
      else if (v === true) e.setAttribute(k, '')
      else e.setAttribute(k, v)
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue
    e.append(c.nodeType ? c : document.createTextNode(String(c)))
  }
  return e
}
export const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild) }
// append() turns null into the text "null", so filter first
export const addAll = (p, ...k) => p.append(...k.flat(Infinity).filter((x) => x != null && x !== false))

// ---------- formatting ----------
export const fmtTime = (ts) => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
export function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + ' min ago'
  if (s < 86400) return Math.floor(s / 3600) + ' h ago'
  return Math.floor(s / 86400) + ' d ago'
}
export const initials = (n) => String(n).split(' ').filter(Boolean).slice(0, 2).map((x) => x[0]).join('')
export const plural = (n, a, b) => n + ' ' + (n === 1 ? a : b)
// Display name: deactivated people stay visible but marked.
export const dn = (p) => (p ? (p.active ? p.name : p.name + ' (deactivated)') : 'Unknown')

// ---------- shared pieces ----------
export const statusPill = (s, tag, props) => h(tag || 'span', Object.assign({ class: 'status-pill status-' + s }, props), h('span', { class: 'dot' }), STATUS_LABEL[s])
export const roleBadge = (r) => h('span', { class: 'role-badge' }, ROLE_LABEL[r])
export const presenceLine = (u) => h('span', { class: 'presence-line' },
  h('span', { class: 'presence-dot p-' + u.presence }), PRESENCE_LABEL[u.presence], u.statusText ? ' · ' + u.statusText : '')
function hashStr(s) { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return x }
export const tagEl = (t) => h('span', { class: 'task-tag tag-c' + (Math.abs(hashStr(t)) % 8) }, t)

let toastTimer = null
export function toast(msg, isErr) {
  let t = document.getElementById('toast')
  if (!t) { t = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t) }
  t.textContent = msg
  t.className = 'toast show' + (isErr ? ' err' : '')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.className = 'toast' }, isErr ? 5000 : 2600)
}

// ---------- inline icons (SVG centres exactly; a text glyph never does) ----------
const SVGNS = 'http://www.w3.org/2000/svg'
export const ICON = { back: 'M19 12H5M11 6l-6 6 6 6', close: 'M6 6l12 12M18 6L6 18', trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3' }
export function svgIcon(d, size) {
  const s = document.createElementNS(SVGNS, 'svg')
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size || 18); s.setAttribute('height', size || 18)
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.2')
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true')
  const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); s.append(p)
  return s
}

// Only our own avatar URLs or a freshly shrunk picture ever become a CSS url().
const AVATAR_OK = /^(\/api\/users\/\d+\/avatar\?v=\d+|data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+)$/
export function avatarEl(u, size, withPresence) {
  const off = !!u && u.active === false
  const a = h('span', { class: 'avatar' + (size ? ' ' + size : '') + (off ? ' inactive' : ''), title: u ? dn(u) : 'Unknown' })
  if (!u) { a.textContent = '?'; return a }
  if (u.avatar && AVATAR_OK.test(u.avatar)) {
    a.style.backgroundImage = 'url("' + u.avatar + '")'
    a.classList.add('has-img')
    a.setAttribute('role', 'img')
    a.setAttribute('aria-label', dn(u))
  } else a.textContent = initials(u.name)
  if (withPresence && !off && u.presence) a.append(h('span', { class: 'presence p-' + u.presence, title: PRESENCE_LABEL[u.presence] }))
  return a
}

export const pageHead = (eyebrow, title, right) => h('div', { class: 'page-head with-actions' },
  h('div', null, eyebrow ? h('p', { class: 'page-eyebrow', text: eyebrow }) : null, h('h1', { class: 'page-title', text: title })),
  right ? h('div', { class: 'head-actions' }, right) : null)
export const emptyState = (title, text, action) => h('div', { class: 'empty-state' },
  h('div', { class: 'empty-cloud' }, '☁'), h('h2', { text: title }), h('p', { text }), action || null)
