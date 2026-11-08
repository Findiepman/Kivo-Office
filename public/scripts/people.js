import { h, toast, fmtTime, plural, avatarEl, presenceLine, dn } from './dom.js'
import { api } from './api.js'
import { openModal, confirmBox } from './modal.js'
import { state, run, render, go } from './state.js'
import { registerCtx } from './ctxmenu.js'

// People rows, account modals and the invite / reset / deactivate flows,
// shared by the IT dashboard, the team page and profile pages. Every "can"
// flag comes from the server's permission rules.

export function roleLine(x) {
  if (!x.active) return h('span', { class: 'badge-off' }, 'Deactivated')
  if (x.pending) {
    const p = x.pendingInvite
    return h('span', { class: 'badge-pending' }, p ? 'Invite pending, expires ' + fmtTime(p.expiresAt) : 'No active invite')
  }
  return presenceLine(x)
}

export function personCtx(x) {
  registerCtx('person:' + x.id, () => {
    const items = [{ label: 'Profile & log', onclick: () => go('#/user/' + x.id) }]
    if (x.can.reset) items.push({ label: x.pending ? 'New invite link' : 'Send reset link', onclick: () => resetModal(x) })
    if (x.can.toggle) {
      if (x.active) items.push({ sep: true }, { label: 'Deactivate', danger: true, onclick: () => deactivateFlow(x) })
      else if (x.can.reactivate) items.push({ sep: true }, { label: 'Reactivate', onclick: () => reactivate(x) })
    }
    return items
  })
}

export function personRow(x) {
  personCtx(x)
  return h('div', { class: 'person-row' + (x.active ? '' : ' off'), 'data-ctx': 'person:' + x.id },
    avatarEl(x, '', true),
    h('div', { class: 'person-main' }, h('a', { class: 'person-name', href: '#/user/' + x.id, text: dn(x) }),
      h('span', { class: 'person-sub' }, '@' + x.username, ' · ', roleLine(x))),
    h('div', { class: 'person-actions' },
      h('a', { class: 'btn-ghost btn-small', href: '#/user/' + x.id }, 'Profile & log'),
      x.can.reset ? h('button', { class: 'btn-ghost btn-small', onclick: () => resetModal(x), text: x.pending ? 'New invite link' : 'Send reset link' }) : null,
      x.can.toggle ? activeToggle(x) : null))
}

const reactivate = (x) => run(() => api.post('/users/' + x.id + '/reactivate'), x.name + ' is active again.')

export function activeToggle(x) {
  if (!x.active && !x.can.reactivate) return h('span', { class: 'card-note', text: 'Deactivated by IT' })
  return x.active
    ? h('button', { class: 'btn-danger-ghost btn-small', onclick: () => deactivateFlow(x), text: 'Deactivate' })
    : h('button', { class: 'btn-ghost btn-small', onclick: () => reactivate(x), text: 'Reactivate' })
}

export function deactivateFlow(x) {
  const b = x.blockers || []
  if (b.includes('last-it')) { toast('This is the last active IT admin. Create or reactivate another IT admin first.', true); return }
  if (b.includes('transfer')) { transferModal(x); return }
  confirmBox('Deactivate ' + x.name + '?', x.name + ' will not be able to sign in, and any open session ends now. Their open tasks become unassigned and are flagged for the roadmap owners. Nothing is deleted, and you can reactivate the account later.', 'Deactivate',
    () => run(() => api.post('/users/' + x.id + '/deactivate'), x.name + ' was deactivated.'), true)
}

async function transferModal(from) {
  let o
  try { o = await api.get('/admin/overview') } catch (e) { toast(e.message, true); return }
  const targets = o.managers.filter((m) => m.active && m.id !== from.id)
  const me = o.managers.find((m) => m.id === from.id) || { ownedRoadmaps: 0, members: [] }
  const rs = me.ownedRoadmaps
  const ms = me.members.length
  const sel = h('select', { id: 'tr-to' }, targets.map((m) => h('option', { value: String(m.id), text: m.name })))
  const err = h('p', { class: 'form-error', role: 'alert' })
  let busy = false
  openModal({
    title: 'Transfer before deactivating', small: true,
    body: h('div', null,
      h('p', { class: 'card-note', text: from.name + ' still owns ' + plural(rs, 'roadmap', 'roadmaps') + ' and has ' + plural(ms, 'team member', 'team members') + '. Pick the manager who takes them over. This is logged.' }),
      targets.length ? h('div', { class: 'form-group' }, h('label', { for: 'tr-to' }, 'New owner'), sel) : h('p', { class: 'form-error', text: 'There is no other active manager. Create one first.' }), err),
    footer: (close) => [h('button', { class: 'btn-ghost', onclick: close, text: 'Cancel' }),
      targets.length ? h('button', {
        class: 'btn',
        text: 'Transfer and deactivate',
        onclick: async () => {
          if (busy) return
          busy = true; err.textContent = ''
          try {
            await api.post('/users/' + from.id + '/transfer', { toId: Number(sel.value), deactivate: true })
            close(); toast('Transferred, and ' + from.name + ' was deactivated.'); render()
          } catch (e) { err.textContent = e.message; render() } finally { busy = false }
        }
      }) : null]
  })
}

// ---------- account modals: no passwords are typed or shown; links are ----------
export function linkModal(who, res) {
  const link = res.link || location.origin + location.pathname + '#/invite/' + res.token
  const input = h('input', { type: 'text', readonly: true, class: 'share-link-input', 'aria-label': 'Link', value: link })
  const fb = h('p', { class: 'assignee-hint', role: 'status' })
  const mailNote = res.emailed === 'sent'
    ? h('p', { class: 'info-note email-note', text: 'We also emailed this link to the address on the account.' })
    : res.emailed === 'failed'
      ? h('p', { class: 'info-note flag email-note', text: 'Sending the email did not work, so pass the link on yourself.' })
      : null
  openModal({
    title: res.kind === 'invite' ? 'Invite link ready' : 'Reset link ready',
    body: h('div', null,
      h('p', { class: 'card-note', text: 'Send this link to ' + who + '. They open it and choose their own password, so nobody else ever sees it. The link works once and expires ' + fmtTime(res.expiresAt) + '.' }),
      h('div', { class: 'copy-box' }, input,
        h('button', {
          class: 'btn btn-small', type: 'button', text: 'Copy link',
          onclick: async () => {
            try { await navigator.clipboard.writeText(link); fb.textContent = 'Copied.' } catch (e) { input.select(); fb.textContent = 'Press Ctrl+C to copy the selected link.' }
          }
        })),
      fb, mailNote,
      h('p', { class: 'info-note', text: 'This is the only time the link is shown. Kivo stores just a hash of it, so you can\'t look it up later. Lost it? Issue a new one.' })),
    footer: (close) => [h('button', { class: 'btn', onclick: close, text: 'Done' })]
  })
  input.focus(); input.select()
}

export function accountModal(role) {
  const name = h('input', { type: 'text', id: 'a-name', maxlength: 40, placeholder: 'e.g. Sam Carter' })
  const un = h('input', { type: 'text', id: 'a-user', maxlength: 24, placeholder: 'e.g. sam', autocomplete: 'off' })
  const email = h('input', { type: 'email', id: 'a-email', maxlength: 254, placeholder: 'sam@company.com', autocomplete: 'off' })
  const err = h('p', { class: 'form-error', role: 'alert' })
  const label = { manager: 'manager', member: 'team member', it: 'IT admin' }[role]
  let busy = false
  const submit = async (close) => {
    if (busy) return; busy = true; err.textContent = ''
    try {
      const r = await api.post('/users', { role, name: name.value, username: un.value, email: email.value })
      close(); render(); linkModal(r.user.name, r)
    } catch (e) { err.textContent = e.message } finally { busy = false }
  }
  openModal({
    title: 'Invite ' + (role === 'it' ? 'an ' : 'a ') + label,
    body: h('form', { onsubmit: (e) => e.preventDefault() },
      h('div', { class: 'form-group' }, h('label', { for: 'a-name' }, 'Name'), name),
      h('div', { class: 'form-group' }, h('label', { for: 'a-user' }, 'Username'), un),
      h('div', { class: 'form-group' }, h('label', { for: 'a-email' }, 'Email ', h('span', { class: 'form-hint' }, '(optional)')), email),
      h('p', { class: 'card-note', text: 'You don\'t choose a password. Kivo makes a one-time invite link for you to send; the new person sets their own password. If email is set up on this server and you fill in an address, the link is emailed too.' }), err),
    footer: (close) => {
      for (const f of [name, un, email]) f.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(close) } })
      return [h('button', { class: 'btn-ghost', onclick: close, text: 'Cancel' }), h('button', { class: 'btn', onclick: () => submit(close), text: 'Create invite link' })]
    }
  })
}

export function resetModal(target) {
  const pending = target.pending
  confirmBox(pending ? 'New invite link?' : 'Send a reset link?',
    pending ? target.name + ' has not activated the account yet. A new link replaces the previous one.'
      : 'This makes a one-time link for ' + target.name + ' to choose a new password. Their current password keeps working until they use it. Any earlier unused link stops working.',
    'Create link', async () => {
      try { const r = await api.post('/users/' + target.id + '/link'); render(); linkModal(target.name, r) } catch (e) { toast(e.message, true) }
    })
}

export const isMe = (x) => !!state.me && state.me.id === x.id
