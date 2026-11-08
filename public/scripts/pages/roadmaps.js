import { h, clear, toast, fmtTime, plural, avatarEl, dn, pageHead, emptyState, ROLE_LABEL } from '../dom.js'
import { api } from '../api.js'
import { openModal, confirmBox } from '../modal.js'
import { state, run, render, go } from '../state.js'
import { registerCtx } from '../ctxmenu.js'
import { topbar } from '../layout.js'
import { personRow, personCtx, roleLine, resetModal, activeToggle, accountModal } from '../people.js'

// ---------- roadmap flows (used by strips, the board and the context menu) ----------
export function deleteRoadmapFlow(r) {
  confirmBox('Delete roadmap?', 'This hides "' + r.title + '" and its tasks for everyone. The activity log is kept and IT can still see it. There is no undo.', 'Delete roadmap',
    () => run(async () => { await api.del('/roadmaps/' + r.id); if (location.hash.indexOf('/roadmap/' + r.id) >= 0) location.hash = '#/' }, 'Roadmap deleted.'), true)
}
export function archiveFlow(r) {
  confirmBox('Archive roadmap?', '"' + r.title + '" becomes read-only for everyone and moves to the Archived section. You can unarchive it at any time.', 'Archive',
    () => run(() => api.post('/roadmaps/' + r.id + '/archive'), 'Roadmap archived.'))
}
export const unarchive = (r) => run(() => api.post('/roadmaps/' + r.id + '/unarchive'), 'Roadmap unarchived.')

// Opens the settings modal from anywhere: the strip only has a summary, so
// the full roadmap (people, task handlers) is fetched first.
export async function openRoadmapSettings(id) {
  try {
    const data = await api.get('/roadmaps/' + id)
    roadmapModal(data)
  } catch (e) { toast(e.message, true) }
}

function roadmapCtx(r) {
  registerCtx('roadmap:' + r.id, () => {
    const items = [{ label: 'Open', onclick: () => go('#/roadmap/' + r.id) }]
    if (r.can.manage) items.push({ label: 'Settings', onclick: () => openRoadmapSettings(r.id) })
    if (r.can.seeLog) items.push({ label: 'Logs', onclick: () => go('#/log/roadmap/' + r.id) })
    if (r.can.archive) items.push(r.archivedAt ? { label: 'Unarchive', onclick: () => unarchive(r) } : { label: 'Archive', onclick: () => archiveFlow(r) })
    if (r.can.manage) items.push({ sep: true }, { label: 'Delete roadmap', danger: true, onclick: () => deleteRoadmapFlow(r) })
    return items
  })
}

// ---------- roadmap strip ----------
export function strip(r, opts) {
  opts = opts || {}
  roadmapCtx(r)
  const c = r.counts
  const pct = (x) => (c.total ? (x / c.total) * 100 : 0)
  const u = state.me
  const people = r.people
  const mgr = r.manager
  const body = [
    h('div', { class: 'strip-top' }, h('div', { class: 'strip-title' }, h('span', { text: r.title }), r.archivedAt ? h('span', { class: 'archived-pill' }, 'Archived') : null)),
    r.description ? h('p', { class: 'strip-desc', text: r.description }) : null,
    h('div', { class: 'strip-runway' },
      h('div', { class: 'runway', role: 'img', 'aria-label': c.finished + ' of ' + c.total + ' tasks finished' },
        h('div', { class: 'seg seg-finished', style: { width: pct(c.finished) + '%' } }),
        h('div', { class: 'seg seg-progress', style: { width: pct(c.in_progress) + '%' } })),
      h('span', { class: 'runway-label', text: c.finished + '/' + c.total + ' finished' })),
    h('div', { class: 'strip-meta' },
      h('span', null, h('i', { class: 'count-dot planned' }), c.planned + ' planned'),
      h('span', null, h('i', { class: 'count-dot in_progress' }), c.in_progress + ' in progress'),
      mgr && opts.showManager ? h('span', { text: 'Manager: ' + dn(mgr) }) : null,
      u.role === 'member' && r.mine ? h('span', { class: 'mine', text: plural(r.mine, 'task', 'tasks') + ' for you' }) : null,
      h('span', { class: 'strip-members' }, h('span', { class: 'avatar-stack' }, people.slice(0, 5).map((p) => avatarEl(p)),
        people.length > 5 ? h('span', { class: 'avatar more', text: '+' + (people.length - 5) }) : null)))
  ]
  return h('a', { class: 'roadmap-strip' + (r.archivedAt ? ' archived' : ''), href: '#/roadmap/' + r.id, 'data-ctx': 'roadmap:' + r.id }, body)
}

// ---------- archived roadmaps: a collapsible block, separate from IT's "Deleted roadmaps" ----------
let archivedOpen = false
function archivedSection(rs, mk) {
  if (!rs.length) return null
  const panel = h('div', { class: 'roadmap-list archived-list', id: 'archived-panel', hidden: !archivedOpen }, rs.map(mk))
  const btn = h('button', {
    class: 'archived-toggle' + (archivedOpen ? ' open' : ''), type: 'button', 'aria-expanded': String(archivedOpen), 'aria-controls': 'archived-panel',
    onclick: () => {
      archivedOpen = !archivedOpen; panel.hidden = !archivedOpen; btn.setAttribute('aria-expanded', String(archivedOpen)); btn.classList.toggle('open', archivedOpen)
    }
  }, h('span', { class: 'chev', 'aria-hidden': 'true' }, '▸'), 'Archived ', h('span', { class: 'section-count', text: String(rs.length) }))
  return h('div', { class: 'archived-block' }, btn, panel)
}

// ---------- home ----------
export async function pageHome() {
  const u = state.me
  if (u.role === 'it') return pageIT()
  const { roadmaps } = await api.get('/roadmaps')
  const rms = roadmaps.filter((r) => !r.archivedAt)
  const arch = roadmaps.filter((r) => r.archivedAt)
  const newBtn = u.role === 'manager' ? h('button', { class: 'btn', onclick: () => roadmapModal(null), text: '+ New roadmap' }) : null
  return h('div', null, topbar({ active: 'home' }),
    h('main', { class: 'page' },
      pageHead(ROLE_LABEL[u.role], 'Your roadmaps', newBtn),
      rms.length
        ? h('div', { class: 'roadmap-list' }, rms.map((r) => strip(r)))
        : emptyState(arch.length ? 'No active roadmaps' : 'Nothing here yet', u.role === 'manager' ? 'Create your first roadmap and add your team to it.' : 'Roadmaps your manager adds you to will show up here.',
          u.role === 'manager' ? h('button', { class: 'btn', onclick: () => roadmapModal(null), text: '+ New roadmap' }) : null),
      archivedSection(arch, (r) => strip(r))))
}

// ---------- IT dashboard ----------
const expanded = new Set()
function itRoadmapCard(r) {
  return h('div', { class: 'it-roadmap' },
    strip(r, { showManager: true }),
    h('div', { class: 'it-roadmap-actions' },
      h('a', { class: 'btn-ghost btn-small', href: '#/log/roadmap/' + r.id }, 'Logs'),
      r.archivedAt ? h('button', { class: 'btn-ghost btn-small', onclick: () => unarchive(r), text: 'Unarchive' })
        : h('button', { class: 'btn-ghost btn-small', onclick: () => archiveFlow(r), text: 'Archive' }),
      h('a', { class: 'btn-ghost btn-small', href: '#/roadmap/' + r.id }, 'Open')))
}
function managerCard(m) {
  personCtx(m)
  const members = m.members
  const open = expanded.has(m.id)
  const panelId = 'mp-' + m.id
  const panel = h('div', { class: 'mgr-panel', id: panelId, hidden: !open },
    members.length ? members.map((x) => personRow(x))
      : h('p', { class: 'access-empty', text: 'This manager has not invited any team members yet.' }))
  const head = h('button', {
    class: 'mgr-head', 'aria-expanded': String(open), 'aria-controls': panelId,
    onclick: (e) => {
      const nowOpen = panel.hidden; panel.hidden = !nowOpen; e.currentTarget.setAttribute('aria-expanded', String(nowOpen))
      if (nowOpen) expanded.add(m.id); else expanded.delete(m.id)
      e.currentTarget.classList.toggle('open', nowOpen)
    }
  },
    h('span', { class: 'chev', 'aria-hidden': 'true' }, '▸'),
    avatarEl(m, '', true),
    h('span', { class: 'person-main' }, h('span', { class: 'person-name', text: dn(m) }), h('span', { class: 'person-sub' }, '@' + m.username + ' · ' + plural(members.length, 'team member', 'team members') + ' · ', roleLine(m))))
  head.classList.toggle('open', open)
  return h('div', { class: 'mgr-card' + (m.active ? '' : ' off') },
    h('div', { class: 'mgr-top', 'data-ctx': 'person:' + m.id }, head,
      h('div', { class: 'mgr-actions' },
        h('a', { class: 'btn-ghost btn-small', href: '#/user/' + m.id }, 'Profile & log'),
        m.can.reset ? h('button', { class: 'btn-ghost btn-small', onclick: () => resetModal(m), text: m.pending ? 'New invite link' : 'Send reset link' }) : null,
        m.can.toggle ? activeToggle(m) : null)),
    panel)
}
async function pageIT() {
  const o = await api.get('/admin/overview')
  const left = h('section', { class: 'it-col' },
    h('div', { class: 'col-head' }, h('h2', { text: 'Roadmaps' }), h('span', { class: 'section-count', text: String(o.roadmaps.length) })),
    o.roadmaps.length ? h('div', { class: 'roadmap-list' }, o.roadmaps.map(itRoadmapCard)) : emptyState('No roadmaps yet', 'Managers create roadmaps from their own dashboard.'),
    archivedSection(o.archived, itRoadmapCard),
    o.deleted.length ? [h('div', { class: 'col-head sp' }, h('h2', { text: 'Deleted roadmaps' }), h('span', { class: 'section-count', text: String(o.deleted.length) })),
      h('p', { class: 'card-note', text: 'Deleted roadmaps disappear for everyone, but their log stays.' }),
      o.deleted.map((r) => h('div', { class: 'deleted-row' }, h('div', { class: 'person-main' }, h('span', { class: 'person-name', text: r.title }),
        h('span', { class: 'person-sub', text: 'Deleted roadmap · was managed by ' + dn(r.manager) + ' · ' + fmtTime(r.deletedAt) })),
        h('a', { class: 'btn-ghost btn-small', href: '#/log/roadmap/' + r.id }, 'Logs')))] : null)

  const right = h('section', { class: 'it-col' },
    h('div', { class: 'col-head' }, h('h2', { text: 'Managers' }), h('span', { class: 'section-count', text: String(o.managers.length) }),
      h('button', { class: 'btn btn-small push-right', onclick: () => accountModal('manager'), text: '+ Invite manager' })),
    o.managers.length ? h('div', { class: 'mgr-list' }, o.managers.map(managerCard)) : emptyState('No managers yet', 'Invite a manager to get started.'),
    h('div', { class: 'col-head sp' }, h('h2', { text: 'IT admins' }), h('span', { class: 'section-count', text: String(o.admins.length) }),
      h('button', { class: 'btn-ghost btn-small push-right', onclick: () => accountModal('it'), text: '+ Invite IT admin' })),
    h('div', { class: 'mgr-card' }, h('div', { class: 'mgr-panel static' }, o.admins.map((x) => personRow(x)))))
  return h('div', null, topbar({ active: 'home' }),
    h('main', { class: 'page wide' }, pageHead('IT admin', 'Everything in Kivo Office'), h('div', { class: 'it-grid' }, left, right)))
}

// ---------- roadmap create / settings ----------
// data: null for a new roadmap, otherwise the board payload { roadmap, people }.
export async function roadmapModal(data) {
  const r = data ? data.roadmap : null
  let addable
  try { addable = await api.get('/people/addable') } catch (e) { toast(e.message, true); return }
  // people already on it who were deactivated since stay listed (and kept)
  const keep = r ? r.memberIds.map((id) => data.people[id]).filter((x) => x && !x.active && !addable.people.some((p) => p.id === x.id)) : []
  const pool = addable.people.concat(keep)
  const name = h('input', { type: 'text', id: 'rm-name', maxlength: 80, value: r ? r.title : '', placeholder: 'e.g. Spring campaign' })
  const desc = h('textarea', { id: 'rm-desc', rows: 3, maxlength: 400, placeholder: 'What is this roadmap for?' })
  desc.value = r ? r.description : ''
  const err = h('p', { class: 'form-error', role: 'alert' })
  const memSel = new Set(r ? r.memberIds : addable.team)
  const crSel = new Set(r ? r.creators : [])
  let mode = r ? r.creatorMode : 'manager'
  const memBox = h('div', { class: 'assignee-picker' })
  const crBox = h('div', { class: 'assignee-picker' })
  const crWrap = h('div', { class: 'form-group' }, h('label', null, 'Task handlers'), crBox)
  const chip = (m, set, after) => {
    const cb = h('input', { type: 'checkbox', checked: set.has(m.id), onchange: () => { if (cb.checked) set.add(m.id); else set.delete(m.id); lab.classList.toggle('selected', cb.checked); after() } })
    const lab = h('label', { class: 'assignee-chip' + (set.has(m.id) ? ' selected' : '') }, cb, avatarEl(m), dn(m) + (m.role === 'manager' ? ' (manager)' : ''))
    return lab
  }
  const paintCr = () => {
    clear(crBox)
    const avail = pool.filter((m) => memSel.has(m.id))
    avail.forEach((m) => crBox.append(chip(m, crSel, () => {})))
    if (!avail.length) crBox.append(h('span', { class: 'assignee-hint', text: 'Add people to the roadmap first.' }))
    crWrap.hidden = mode !== 'chosen'
  }
  const paintMem = () => {
    clear(memBox)
    pool.forEach((m) => memBox.append(chip(m, memSel, () => { [...crSel].forEach((id) => { if (!memSel.has(id)) crSel.delete(id) }); paintCr() })))
    if (!pool.length) memBox.append(h('span', { class: 'assignee-hint', text: 'There is nobody to add yet. Invite team members under "My team".' }))
  }
  const radio = (val, title, sub) => {
    const inp = h('input', { type: 'radio', name: 'cmode', value: val, checked: mode === val, onchange: () => { mode = val; paintCr() } })
    return h('label', { class: 'radio-row' }, inp, h('span', null, h('strong', { text: title }), h('span', { class: 'radio-sub', text: sub })))
  }
  paintMem(); paintCr()
  let busy = false
  const save = async (close) => {
    if (busy) return
    busy = true; err.textContent = ''
    const body = { title: name.value, description: desc.value, memberIds: [...memSel], creatorMode: mode, creators: mode === 'chosen' ? [...crSel] : [] }
    // the version this form was loaded from: the server refuses the save if someone changed the roadmap since
    if (r) body.updatedAt = r.updatedAt
    try {
      const res = r ? await api.put('/roadmaps/' + r.id, body) : await api.post('/roadmaps', body)
      close(); toast(r ? 'Roadmap saved.' : 'Roadmap created.')
      if (!r) go('#/roadmap/' + res.roadmap.id); else render()
    } catch (e) { err.textContent = e.message } finally { busy = false }
  }
  openModal({
    title: r ? 'Roadmap settings' : 'New roadmap',
    body: h('div', null,
      h('div', { class: 'form-group' }, h('label', { for: 'rm-name' }, 'Name'), name),
      h('div', { class: 'form-group' }, h('label', { for: 'rm-desc' }, 'Description'), desc),
      h('div', { class: 'form-group' }, h('label', null, 'Who is on this roadmap?'), memBox,
        h('span', { class: 'assignee-hint', text: 'Any active team member or manager, not only your own team. You are the owner.' })),
      h('div', { class: 'form-group' }, h('label', null, 'Who can create tasks?'),
        radio('everyone', 'Everyone on the roadmap', 'Anyone on it can add tasks and assign people to their own tasks.'),
        radio('manager', 'Manager only', 'Only you create tasks and assign people.'),
        radio('chosen', 'Manager + chosen task handlers', 'You and the people you pick below.')),
      crWrap, err),
    footer: (close) => [
      r ? h('button', {
        class: 'btn-danger-ghost push-left', text: 'Delete roadmap',
        onclick: () => confirmBox('Delete roadmap?', 'This hides "' + r.title + '" and its tasks for everyone. The activity log is kept and IT can still see it. There is no undo.', 'Delete roadmap',
          async () => { close(); await run(async () => { await api.del('/roadmaps/' + r.id); location.hash = '#/' }, 'Roadmap deleted.') }, true)
      }) : null,
      h('button', { class: 'btn-ghost', onclick: close, text: 'Cancel' }),
      h('button', { class: 'btn', onclick: () => save(close), text: r ? 'Save settings' : 'Create roadmap' })
    ]
  })
}
