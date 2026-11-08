import { h, clear, addAll, toast, fmtTime, avatarEl, dn, statusPill, tagEl, svgIcon, ICON, STATUSES, STATUS_LABEL } from '../dom.js'
import { api } from '../api.js'
import { openModal, confirmBox, closeAllModals } from '../modal.js'
import { state, run, render } from '../state.js'
import { registerCtx } from '../ctxmenu.js'
import { moveTask } from './board.js'

export function deleteTaskFlow(t) {
  confirmBox('Delete task?', 'This removes the task and its comments for everyone. The log keeps a record. There is no undo.', 'Delete task',
    () => run(() => api.del('/tasks/' + t.id), 'Task deleted.'), true)
}

// t: a task from the board payload (null for a new one). ctx: { r, people, assignable }.
export function taskModal(t, ctx) {
  const u = state.me
  const r = ctx.r
  const isNew = !t
  const creator = r.can.create
  const assigner = isNew ? creator : t.can.assign
  if (isNew && !creator) return
  const canEdit = isNew ? true : t.can.edit
  const archived = !!r.archivedAt
  const selected = new Set(isNew ? [] : t.assignees)
  const err = h('p', { class: 'form-error', role: 'alert' })
  const openStatus = isNew ? 'planned' : t.status // what the modal opened with
  let status = openStatus
  let commentsChanged = false
  const body = h('div')

  const name = h('input', { type: 'text', id: 't-name', maxlength: 120, value: isNew ? '' : t.title, placeholder: 'e.g. Write the launch post' })
  const desc = h('textarea', { id: 't-desc', rows: 4, maxlength: 2000, placeholder: 'Describe this task' })
  desc.value = isNew ? '' : t.description
  const tags = h('input', { type: 'text', id: 't-tags', maxlength: 200, value: isNew ? '' : t.tags.join(', '), placeholder: 'comma separated, e.g. Design, Launch' })

  if (!isNew && t.flags.length && !t.assignees.length) {
    body.append(h('p', { class: 'info-note flag', text: 'Needs a new assignee: ' + t.flags.map((f) => dn(ctx.people[f.userId]) + ' (' + f.reason + ')').join(', ') + '.' }))
  }
  if (canEdit) {
    body.append(h('div', { class: 'form-group' }, h('label', { for: 't-name' }, 'Name'), name),
      h('div', { class: 'form-group' }, h('label', { for: 't-desc' }, 'Description'), desc))
    if (!isNew) {
      const seg = h('div', { class: 'status-seg' }, STATUSES.map((s) => {
        const m = s === t.status ? { ok: true } : t.can.moves[s]
        return h('button', {
          type: 'button', 'data-status': s, class: s === status ? 'active' : '', disabled: !m.ok, title: m.ok ? '' : m.reason, text: STATUS_LABEL[s],
          onclick: () => { status = s; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.status === s)) }
        })
      }))
      body.append(h('div', { class: 'form-group' }, h('label', null, 'Status'), seg,
        h('span', { class: 'assignee-hint', text: r.can.owner ? 'Tasks move forward only. As the owner you can also move one back; that is logged as an override.' : 'Tasks move forward only: Planned, In progress, Finished. You will be asked to confirm.' })))
    }
    body.append(h('div', { class: 'form-group' }, h('label', { for: 't-tags' }, 'Tags'), tags))
  } else {
    addAll(body,
      h('div', { class: 'ro-block' }, h('h4', { class: 'ro-title', text: t.title }), statusPill(t.status)),
      t.description ? h('p', { class: 'ro-desc', text: t.description }) : h('p', { class: 'ro-desc muted', text: 'No description.' }),
      t.tags.length ? h('div', { class: 'task-tags ro-tags' }, t.tags.map(tagEl)) : null,
      h('p', { class: 'info-note', text: archived ? 'This roadmap is archived, so the task is read-only.' : u.role === 'it' ? 'Admins can read and comment. Only assigned people can edit.' : 'Only the people assigned to this task can edit it or mark it complete. You can read it and leave a comment.' }))
    if (r.can.owner && !archived && t.status !== 'planned') {
      const back = STATUSES.slice(0, STATUSES.indexOf(t.status))
      body.append(h('div', { class: 'form-group' }, h('label', null, 'Owner override'),
        h('div', { class: 'head-actions left0' }, back.map((s) => h('button', { class: 'btn-ghost btn-small', type: 'button', text: 'Move back to ' + STATUS_LABEL[s], onclick: () => moveTask(t, s, closeAllModals) })))))
    }
  }

  // assignees: editable only for people who may assign
  const pool = ctx.assignable.map((id) => ctx.people[id]).filter(Boolean)
  if (assigner) {
    const picker = h('div', { class: 'assignee-picker' }, pool.map((p) => {
      const cb = h('input', { type: 'checkbox', checked: selected.has(p.id), onchange: () => { if (cb.checked) selected.add(p.id); else selected.delete(p.id); lab.classList.toggle('selected', cb.checked) } })
      const lab = h('label', { class: 'assignee-chip' + (selected.has(p.id) ? ' selected' : '') }, cb, avatarEl(p), p.id === r.managerId ? p.name + ' (owner)' : p.name)
      return lab
    }))
    body.append(h('div', { class: 'form-group' }, h('label', null, 'Who is working on this?'), picker,
      h('span', { class: 'assignee-hint', text: 'Only the people you pick can edit this task or mark it complete.' })))
  } else if (!isNew) {
    const ppl = t.assignees.map((id) => ctx.people[id]).filter(Boolean)
    body.append(h('div', { class: 'form-group' }, h('label', null, 'Assigned to'),
      ppl.length ? h('div', { class: 'assignee-picker' }, ppl.map((p) => h('span', { class: 'assignee-chip selected static' }, avatarEl(p), dn(p))))
        : h('span', { class: 'assignee-hint', text: 'Nobody is assigned yet, so nobody can edit this task.' })))
  }

  // comments
  if (!isNew) {
    const list = h('div', { class: 'comments' }, h('p', { class: 'access-empty', text: 'Loading comments...' }))
    const paint = async () => {
      let res
      try { res = await api.get('/tasks/' + t.id + '/comments') } catch (e) {
        clear(list); list.append(h('p', { class: 'access-empty', text: e.status === 404 ? 'This task no longer exists.' : e.message }))
        return
      }
      clear(list)
      if (!res.comments.length) list.append(h('p', { class: 'access-empty', text: 'No comments yet.' }))
      res.comments.forEach((c) => {
        const a = res.people[c.userId]
        if (c.canDelete) registerCtx('comment:' + c.id, () => [{ label: 'Delete comment', danger: true, onclick: () => deleteCommentFlow(c) }])
        else registerCtx('comment:' + c.id, () => [])
        list.append(h('div', { class: 'comment', 'data-ctx': 'comment:' + c.id }, avatarEl(a),
          h('div', { class: 'comment-main' },
            h('div', { class: 'comment-head' }, h('strong', { text: dn(a) }), h('time', { text: ' ' + fmtTime(c.at) }),
              c.canDelete ? h('button', { class: 'comment-del', type: 'button', title: 'Delete comment', 'aria-label': 'Delete comment', onclick: () => deleteCommentFlow(c) }, svgIcon(ICON.trash, 14)) : null),
            h('p', { text: c.text }))))
      })
      list.scrollTop = list.scrollHeight
    }
    const deleteCommentFlow = (c) => {
      confirmBox('Delete comment?', 'This removes the comment from the thread. The activity log keeps a note that it was deleted, but not the text.', 'Delete comment',
        async () => {
          try { await api.del('/comments/' + c.id); commentsChanged = true; paint() } catch (e) { cerr.textContent = e.message }
        }, true)
    }
    const box = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Write a comment', 'aria-label': 'Write a comment' })
    const cerr = h('p', { class: 'form-error', role: 'alert' })
    let posting = false
    const post = async () => {
      if (posting) return
      cerr.textContent = ''
      posting = true
      try { await api.post('/tasks/' + t.id + '/comments', { text: box.value }); box.value = ''; commentsChanged = true; await paint() } catch (e) { cerr.textContent = e.message } finally { posting = false }
    }
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post() } })
    paint()
    body.append(h('div', { class: 'comments-block' }, h('h4', { class: 'block-title', text: 'Comments' }), list,
      archived ? h('p', { class: 'assignee-hint', text: 'Archived roadmap: comments are closed.' })
        : [h('div', { class: 'comment-form' }, box, h('button', { class: 'btn btn-small', type: 'button', onclick: post, text: 'Post comment' })), cerr]))
  }
  body.append(err)

  let saving = false
  const doSave = async (close) => {
    if (saving) return
    saving = true; err.textContent = ''
    try {
      if (isNew) await api.post('/roadmaps/' + r.id + '/tasks', { title: name.value, description: desc.value, tags: tags.value, assignees: [...selected] })
      else {
        const patch = {}
        if (canEdit) Object.assign(patch, { title: name.value, description: desc.value, tags: tags.value })
        if (canEdit && status !== openStatus) Object.assign(patch, { status, fromStatus: openStatus })
        if (assigner) patch.assignees = [...selected]
        // the version this form was loaded from: the server refuses the save if someone changed the task since
        if (canEdit || assigner) patch.updatedAt = t.updatedAt
        await api.patch('/tasks/' + t.id, patch)
      }
      commentsChanged = false
      close(); toast(isNew ? 'Task created.' : 'Task saved.'); render()
    } catch (e) { err.textContent = e.message; render() } finally { saving = false }
  }
  const save = (close) => {
    if (!isNew && canEdit && status !== openStatus) {
      confirmBox('Move task?', 'Move ' + t.title + ' to ' + STATUS_LABEL[status] + '? This can\'t be undone.', 'Move task', () => doSave(close))
    } else doSave(close)
  }
  const canSave = canEdit || assigner
  openModal({
    // the comment count on the board is out of date after posting or deleting
    onClose: () => { if (commentsChanged) render() },
    title: isNew ? 'New task' : (canEdit ? 'Edit task' : 'Task'),
    body,
    footer: (close) => [
      !isNew && t.can.delete ? h('button', {
        class: 'btn-danger-ghost push-left', text: 'Delete task',
        onclick: () => confirmBox('Delete task?', 'This removes the task and its comments for everyone. The log keeps a record. There is no undo.', 'Delete task',
          async () => { close(); await run(() => api.del('/tasks/' + t.id), 'Task deleted.') }, true)
      }) : null,
      h('button', { class: 'btn-ghost', onclick: close, text: canSave ? 'Cancel' : 'Close' }),
      canSave ? h('button', { class: 'btn', onclick: () => save(close), text: isNew ? 'Create task' : 'Save task' }) : null
    ]
  })
}
