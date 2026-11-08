import { h, toast, plural, avatarEl, dn, statusPill, tagEl, emptyState, STATUSES, STATUS_LABEL } from '../dom.js'
import { api } from '../api.js'
import { confirmBox } from '../modal.js'
import { state, run, render } from '../state.js'
import { registerCtx } from '../ctxmenu.js'
import { attachDrag, clickSuppressed } from '../drag.js'
import { topbar, pageMissing } from '../layout.js'
import { roadmapModal, archiveFlow, unarchive } from './roadmaps.js'
import { taskModal, deleteTaskFlow } from './task.js'

let viewMode = 'list'
try { viewMode = localStorage.getItem('kivo-office-view') === 'board' ? 'board' : 'list' } catch (e) { /* blocked */ }

function creatorsLabel(r, people) {
  if (r.creatorMode === 'everyone') return 'Everyone on the roadmap can create tasks'
  if (r.creatorMode === 'manager') return 'Tasks created by the owner only'
  const n = r.creators.map((id) => people[id]).filter(Boolean).map(dn)
  return 'Owner + task handlers' + (n.length ? ': ' + n.join(', ') : '')
}

// One entry point for every status change (drag, menu, modal): confirm first,
// the server enforces the rules. fromStatus makes the server refuse the move
// if someone else moved the task while this dialog was open.
export function moveTask(t, to, afterOk) {
  const from = t.status
  const m = t.can.moves[to] || { ok: false, reason: 'The task is already there.' }
  if (!m.ok) { toast(m.reason, true); return }
  confirmBox('Move task?', 'Move ' + t.title + ' to ' + STATUS_LABEL[to] + '? This can\'t be undone.', 'Move task',
    () => run(() => api.patch('/tasks/' + t.id, { status: to, fromStatus: from }), 'Moved to ' + STATUS_LABEL[to].toLowerCase() + '.')
      .then((ok) => { if (ok && afterOk) afterOk() }))
}

function taskCtx(t, ctx) {
  registerCtx('task:' + t.id, () => {
    const items = [{ label: t.can.edit ? 'Open and edit' : 'Open', onclick: () => taskModal(t, ctx) }]
    STATUSES.forEach((s) => {
      if (s === t.status) return
      const m = t.can.moves[s]
      if (m && m.ok) items.push({ label: (m.override ? 'Move back to ' : 'Move to ') + STATUS_LABEL[s], onclick: () => moveTask(t, s) })
    })
    if (t.can.assign) items.push({ label: 'Assign people', onclick: () => taskModal(t, ctx) })
    if (t.can.delete) items.push({ sep: true }, { label: 'Delete task', danger: true, onclick: () => deleteTaskFlow(t) })
    return items
  })
}

function taskRow(t, ctx) {
  taskCtx(t, ctx)
  const people = t.assignees.map((id) => ctx.people[id]).filter(Boolean)
  const flagged = t.flags.length && !t.assignees.length
  const menu = h('div', { class: 'menu status-menu' }, STATUSES.map((s) => {
    const m = s === t.status ? { ok: false } : t.can.moves[s]
    return h('button', {
      class: 'menu-item', type: 'button', disabled: !m.ok, title: s === t.status ? 'Current status' : (m.ok ? '' : m.reason), text: STATUS_LABEL[s],
      onclick: (e) => { e.stopPropagation(); menu.classList.remove('open'); moveTask(t, s) }
    })
  }))
  const canChange = STATUSES.some((s) => s !== t.status && t.can.moves[s].ok)
  const pill = canChange
    ? h('div', { class: 'menu-wrap' }, statusPill(t.status, 'button', {
        type: 'button', title: 'Change status', 'aria-haspopup': 'menu',
        onclick: (e) => { e.stopPropagation(); const open = menu.classList.contains('open'); document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); if (!open) menu.classList.add('open') }
      }), menu)
    : statusPill(t.status, 'span', { title: 'You can\'t change this status' })
  const row = h('div', {
    class: 'task-row ' + t.status + (canChange ? ' can-drag' : ''), tabindex: '0', role: 'button', 'data-ctx': 'task:' + t.id, 'aria-label': 'Open task ' + t.title,
    onclick: () => { if (!clickSuppressed()) taskModal(t, ctx) },
    onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === row) { e.preventDefault(); taskModal(t, ctx) } }
  },
    pill,
    h('span', { class: 'task-name', text: t.title }),
    t.tags.length ? h('span', { class: 'task-tags' }, t.tags.map(tagEl)) : null,
    h('span', { class: 'row-right' },
      t.commentCount ? h('span', { class: 'row-meta', text: plural(t.commentCount, 'comment', 'comments') }) : null,
      t.can.edit ? h('span', { class: 'you-badge', text: 'Yours' }) : h('span', { class: 'ro-badge', text: 'Read only' }),
      people.length ? h('span', { class: 'avatar-stack', title: people.map(dn).join(', ') }, people.slice(0, 4).map((p) => avatarEl(p)))
        : h('span', { class: 'row-meta unassigned' + (flagged ? ' flagged' : ''), text: flagged ? 'Needs a new assignee' : 'Unassigned' })))
  if (canChange) attachDrag(row, { status: t.status, canMove: (to) => t.can.moves[to] || { ok: false }, onDrop: (to) => moveTask(t, to) })
  return row
}

export async function pageRoadmap(rid) {
  const u = state.me
  let data
  try { data = await api.get('/roadmaps/' + encodeURIComponent(rid)) } catch (e) {
    if (e.status === 401) throw e
    return pageMissing('That roadmap doesn\'t exist, or you don\'t have access to it.')
  }
  const { roadmap: r, tasks, people } = data
  const ctx = { r, people, assignable: data.assignable, data }
  const mgr = people[r.managerId]
  const archived = !!r.archivedAt
  const creator = r.can.create
  const team = [mgr].concat(r.memberIds.map((id) => people[id])).filter(Boolean)
  const seg = h('div', { class: 'view-seg', role: 'group', 'aria-label': 'Layout' },
    ['list', 'board'].map((m) => h('button', {
      type: 'button', class: viewMode === m ? 'active' : '', 'aria-pressed': String(viewMode === m), text: m === 'list' ? 'List' : 'Board',
      onclick: () => { viewMode = m; try { localStorage.setItem('kivo-office-view', m) } catch (e) { /* blocked */ } render() }
    })))
  const right = [
    h('div', { class: 'avatar-stack', title: team.map(dn).join(', ') }, team.slice(0, 5).map((p) => avatarEl(p))),
    seg,
    r.can.seeLog ? h('a', { class: 'btn-ghost btn-small', href: '#/log/roadmap/' + r.id }, 'Logs') : null,
    r.can.manage ? h('button', { class: 'btn-ghost btn-small', onclick: () => roadmapModal(data), text: 'Settings' }) : null,
    r.can.archive && !archived ? h('button', { class: 'btn-ghost btn-small', onclick: () => archiveFlow(r), text: 'Archive' }) : null,
    creator ? h('button', { class: 'btn', onclick: () => taskModal(null, ctx), text: '+ Add task' }) : null
  ]
  const notes = []
  const banner = archived ? h('div', { class: 'archived-banner', role: 'status' },
    h('div', null, h('strong', { text: 'Archived. ' }), 'This roadmap is read-only: nobody can add, edit, move or assign tasks, or comment.'),
    r.can.archive ? h('button', { class: 'btn btn-small', onclick: () => unarchive(r), text: 'Unarchive' }) : null) : null
  const flagged = tasks.filter((t) => t.flags.length && !t.assignees.length)
  if (r.can.owner && flagged.length) notes.push(plural(flagged.length, 'task needs', 'tasks need') + ' a new assignee because someone was deactivated or removed.')
  if (archived) { /* the banner says it */ } else if (u.role === 'it') notes.push('You are viewing as an IT admin. You can read and comment, but only assigned people edit tasks.')
  else if (!creator) notes.push('You can edit the tasks assigned to you. Everything else is read-only, but you can comment on any task.')
  const sections = STATUSES.map((s) => {
    const list = tasks.filter((t) => t.status === s)
    const rows = h('div', { class: 'task-rows' }, list.map((t) => taskRow(t, ctx)))
    return h('section', { class: 'status-section', 'data-status': s },
      h('div', { class: 'section-header' }, h('span', { class: 'section-dot ' + s }), h('h2', { text: STATUS_LABEL[s] }), h('span', { class: 'section-count', text: String(list.length) })),
      rows,
      list.length ? null : h('p', { class: 'section-empty', text: { planned: 'Nothing planned yet.', in_progress: 'Nothing is being worked on right now.', finished: 'Nothing finished yet.' }[s] }))
  })
  const page = h('div', null,
    topbar({ back: '#/', title: r.title, meta: (archived ? 'Archived · ' : '') + 'Owner: ' + dn(mgr) + ' · ' + creatorsLabel(r, people), right }),
    h('main', { class: 'page' + (viewMode === 'board' ? ' wide' : '') },
      banner,
      r.description ? h('p', { class: 'roadmap-desc', text: r.description }) : null,
      notes.map((n) => h('p', { class: 'info-note', text: n })),
      tasks.length || creator || archived ? null : emptyState('No tasks yet', 'The people who create tasks on this roadmap haven\'t added any.'),
      h('div', { class: viewMode === 'board' ? 'board' : 'list-view' }, sections)))
  // the router sets the tab title, only for the render it actually shows
  page.kivoTitle = r.title + ' · Kivo Office'
  return page
}

