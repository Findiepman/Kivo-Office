import { h, clear, fmtTime, plural, dn, pageHead } from '../dom.js'
import { api } from '../api.js'
import { state } from '../state.js'
import { topbar, pageMissing } from '../layout.js'

const ACTION_CLASS = { login: 'tag-c0', account: 'tag-c1', password: 'tag-c3', roadmap: 'tag-c6', task: 'tag-c5', comment: 'tag-c2', profile: 'tag-c7', security: 'tag-c4', override: 'tag-c2', transfer: 'tag-c6' }
const NOTE = 'This log is append-only. Nobody can edit or delete entries, IT admins included.'

// A filterable, paginated log. fetchPage(q, page) returns the server's
// { entries, people, total, page, pages }; rowFor turns one entry into an <li>.
export function pagedList(fetchPage, rowFor, opts) {
  opts = opts || {}
  const list = h('ul', { class: 'log-list' })
  const count = h('span', { class: 'log-count' })
  const status = h('p', { class: 'log-loading', text: 'Loading...' })
  const prev = h('button', { class: 'btn-ghost btn-small', type: 'button', text: 'Newer' })
  const next = h('button', { class: 'btn-ghost btn-small', type: 'button', text: 'Older' })
  const where = h('span', { class: 'log-count' })
  const pager = h('div', { class: 'pager', hidden: true }, prev, where, next)
  let page = 1
  let q = ''
  let seq = 0
  // `page` only changes once a page really loaded, so a failed request
  // (offline, server error) never leaves the pager one page off
  const load = async (target) => {
    const mine = ++seq
    status.hidden = false; status.textContent = 'Loading...'
    let data
    try { data = await fetchPage(q, target) } catch (e) {
      if (mine !== seq) return
      status.textContent = e.message
      return
    }
    if (mine !== seq) return // a newer search already went out
    clear(list)
    data.entries.forEach((en) => list.append(rowFor(en, data.people || {})))
    count.textContent = plural(data.total, 'entry', 'entries')
    status.hidden = data.entries.length > 0
    status.textContent = data.total ? '' : (q ? 'Nothing matches that filter.' : (opts.empty || 'Nothing logged yet.'))
    page = data.page
    pager.hidden = data.pages <= 1
    prev.disabled = data.page <= 1
    next.disabled = data.page >= data.pages
    where.textContent = 'Page ' + data.page + ' of ' + data.pages
  }
  prev.addEventListener('click', () => { if (page > 1) load(page - 1) })
  next.addEventListener('click', () => load(page + 1))
  let timer = null
  const search = h('input', {
    type: 'search', class: 'log-search', placeholder: 'Filter this log', 'aria-label': 'Filter this log',
    oninput: () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value.trim(); load(1) }, 250) }
  })
  load(1)
  return h('div', { class: 'log-wrap' }, h('p', { class: 'log-note' }, NOTE), h('div', { class: 'log-tools' }, search, count), list, status, pager)
}

// actor null: a failed sign-in comes from an unknown visitor, anything else from the server itself
const actorName = (l, people) => (l.actorId ? dn(people[l.actorId]) : (l.action === 'security' ? 'Unknown visitor' : 'Kivo Office'))

export function logRow(l, people, opts) {
  return h('li', { class: 'log-row' },
    h('time', { class: 'log-time', datetime: new Date(l.at).toISOString(), title: new Date(l.at).toString(), text: fmtTime(l.at) }),
    h('span', { class: 'log-chip task-tag ' + (ACTION_CLASS[l.action] || 'tag-c0'), text: l.action }),
    h('span', { class: 'log-text' },
      opts && opts.hideActor ? null : [h('strong', { text: actorName(l, people) }), ' '], l.text))
}

export const logList = (path, opts) => pagedList((q, page) => api.get(path, Object.assign({ q, page }, opts && opts.params)), (l, people) => logRow(l, people, opts), opts)

export async function pageRoadmapLog(rid) {
  const u = state.me
  let first
  try { first = await api.get('/roadmaps/' + encodeURIComponent(rid) + '/log') } catch (e) {
    return pageMissing('That log doesn\'t exist, or you can\'t view it.')
  }
  const r = first.roadmap
  return h('div', null, topbar({ back: u.role === 'it' || r.deletedAt ? '#/' : '#/roadmap/' + r.id, title: 'Logs: ' + r.title, meta: (r.deletedAt ? 'Deleted roadmap · ' : '') + 'Everything that happened on this roadmap, newest first' }),
    h('main', { class: 'page' }, h('div', { class: 'settings-card' }, logList('/roadmaps/' + r.id + '/log', { empty: 'Nothing has happened on this roadmap yet.' }))))
}

export async function pageGlobalLog() {
  if (state.me.role !== 'it') return pageMissing('Only IT admins can see the full activity log.')
  return h('div', null, topbar({ active: 'log' }),
    h('main', { class: 'page' }, pageHead('IT admin', 'All activity'), h('div', { class: 'settings-card' }, logList('/admin/log'))))
}

const KIND = {
  invite_issued: ['invite link issued', 'tag-c0'], invite_used: ['invite used, password set', 'tag-c1'],
  reset_issued: ['reset link issued', 'tag-c2'], reset_used: ['reset used, password set', 'tag-c1'],
  setup_issued: ['setup link printed', 'tag-c6'], setup_used: ['setup link used', 'tag-c1']
}

export async function pagePasswords() {
  if (state.me.role !== 'it') return pageMissing('Only IT admins can see the password log.')
  const row = (p, people) => {
    const t = p.userId ? people[p.userId] : null
    const by = p.byId ? people[p.byId] : null
    const k = KIND[p.kind] || [p.kind, 'tag-c0']
    const self = p.byId && p.byId === p.userId
    return h('li', { class: 'log-row pw-row' },
      h('time', { class: 'log-time', text: fmtTime(p.at), title: new Date(p.at).toString() }),
      h('span', { class: 'log-chip task-tag ' + k[1], text: k[0] }),
      h('span', { class: 'log-text' },
        h('strong', { text: t ? dn(t) : (p.kind === 'setup_issued' ? 'A new IT admin' : 'Unknown account') }), t ? ' (@' + t.username + ')' : '',
        self ? ' · by themselves' : [' · by ', h('strong', { text: by ? dn(by) : 'the server console' })]))
  }
  return h('div', null, topbar({ active: 'pw' }),
    h('main', { class: 'page' }, pageHead('IT admin', 'Password log'),
      h('div', { class: 'settings-card' },
        h('p', { class: 'card-note', text: 'Who issued an invite or reset link, and when it was used. Nobody sets anyone else\'s password: people choose their own through a one-time link, and only a bcrypt hash of it is stored.' }),
        pagedList((q, page) => api.get('/admin/passwords', { q, page }), row))))
}
