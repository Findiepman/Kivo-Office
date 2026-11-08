import { h, clear, toast, fmtTime, ago, avatarEl, dn, roleBadge, pageHead, emptyState, PRESENCE, PRESENCE_LABEL, ROLE_LABEL } from '../dom.js'
import { api } from '../api.js'
import { state, render } from '../state.js'
import { topbar, pageMissing } from '../layout.js'
import { personRow, personCtx, roleLine, resetModal, activeToggle, accountModal } from '../people.js'
import { logList } from './logs.js'

// ---------- team (manager) ----------
export async function pageTeam() {
  const u = state.me
  if (u.role !== 'manager') return pageMissing('Only managers have a team page.')
  const { members: ms } = await api.get('/team')
  return h('div', null, topbar({ active: 'team' }),
    h('main', { class: 'page' },
      pageHead('Manager', 'My team', h('button', { class: 'btn', onclick: () => accountModal('member'), text: '+ Invite team member' })),
      ms.length ? h('div', { class: 'mgr-card' }, h('div', { class: 'mgr-panel static' }, ms.map((x) => personRow(x))))
        : emptyState('No team members yet', 'Invite each person. They get a one-time link and choose their own password.',
          h('button', { class: 'btn', onclick: () => accountModal('member'), text: '+ Invite team member' }))))
}

// ---------- user page ----------
export async function pageUser(id) {
  const u = state.me
  let t
  try { t = (await api.get('/users/' + encodeURIComponent(id))).user } catch (e) {
    if (e.status === 401) throw e
    return pageMissing('That account doesn\'t exist, or you can\'t view it.')
  }
  personCtx(t)
  const head = h('div', { class: 'settings-card profile-head', 'data-ctx': 'person:' + t.id },
    avatarEl(t, 'avatar-xl', true),
    h('div', { class: 'profile-main' },
      h('h2', { class: 'account-name', text: dn(t) }),
      h('p', { class: 'person-sub' }, '@' + t.username, ' ', roleBadge(t.role)),
      h('p', { class: 'profile-status' }, roleLine(t)),
      t.email ? h('p', { class: 'person-sub', text: t.email }) : null,
      h('p', { class: 'person-sub', text: [t.createdBy ? 'Invited by ' + dn(t.createdBy) : t.original ? 'Original admin' : 'Added with a setup link', 'on ' + fmtTime(t.createdAt), t.lastLogin ? 'last signed in ' + ago(t.lastLogin) : 'never signed in'].join(' · ') }),
      h('div', { class: 'head-actions left' },
        t.can.reset ? h('button', { class: 'btn-ghost btn-small', onclick: () => resetModal(t), text: t.pending ? 'New invite link' : 'Send reset link' }) : null,
        t.can.toggle ? activeToggle(t) : null,
        t.isMe ? h('a', { class: 'btn btn-small', href: '#/profile' }, 'Edit my profile') : null)))
  let logs = null
  if (t.can.seeLog) {
    // "done to this account by others" only shows when there is something in it
    const about = await api.get('/users/' + t.id + '/log', { part: 'about' })
    logs = [
      h('h3', { class: 'card-title', text: 'Account log: what ' + t.name.split(' ')[0] + ' did' }),
      logList('/users/' + t.id + '/log', { params: { part: 'by' }, hideActor: true, empty: 'This account has not done anything yet.' }),
      about.total ? [h('h3', { class: 'card-title sp', text: 'Done to this account by others' }), logList('/users/' + t.id + '/log', { params: { part: 'about' } })] : null
    ]
  }
  return h('div', null, topbar({ back: u.role === 'manager' && !t.isMe ? '#/team' : '#/', title: dn(t), meta: ROLE_LABEL[t.role] }),
    h('main', { class: 'page' }, head, logs ? h('div', { class: 'settings-card' }, logs) : null))
}

// ---------- profile editor ----------
// Shrunk to a 128 px JPEG here; the server checks it again (type, size, magic bytes).
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\/(jpeg|png|webp|gif)$/.test(file.type)) return reject(new Error('Choose a JPG, PNG, WebP or GIF picture.'))
    if (file.size > 8 * 1024 * 1024) return reject(new Error('That picture is over 8 MB. Pick a smaller one.'))
    const fr = new FileReader()
    fr.onerror = () => reject(new Error('Could not read that file.'))
    fr.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('That file isn\'t a readable picture.'))
      img.onload = () => {
        const S = 128; const cv = document.createElement('canvas'); cv.width = S; cv.height = S
        const ctx = cv.getContext('2d'); const m = Math.min(img.width, img.height)
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, S, S)
        ctx.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, S, S)
        resolve(cv.toDataURL('image/jpeg', 0.82))
      }
      img.src = fr.result
    }
    fr.readAsDataURL(file)
  })
}

export function pageProfile() {
  const u = state.me
  const original = u.avatar
  let avatar = u.avatar; let presence = u.presence
  const preview = h('div', { class: 'avatar-preview' })
  const paintAv = () => { clear(preview); preview.append(avatarEl({ name: u.name, avatar, presence, active: true }, 'avatar-xl')) }
  paintAv()
  const err = h('p', { class: 'form-error', role: 'alert' })
  const name = h('input', { type: 'text', id: 'p-name', maxlength: 40, value: u.name })
  const text = h('input', { type: 'text', id: 'p-text', maxlength: 80, value: u.statusText, placeholder: 'e.g. In a meeting until 14:00' })
  const email = h('input', { type: 'email', id: 'p-email', maxlength: 254, value: u.email || '', placeholder: 'you@company.com', autocomplete: 'email' })
  const file = h('input', {
    type: 'file', accept: 'image/*', id: 'p-file', class: 'sr-file',
    onchange: async () => {
      err.textContent = ''
      try { avatar = await resizeImage(file.files[0]); paintAv() } catch (e) { err.textContent = e.message }
      file.value = ''
    }
  })
  const seg = h('div', { class: 'status-seg presence-seg' }, PRESENCE.map((p) => h('button', { type: 'button', 'data-p': p, class: p === presence ? 'active' : '', onclick: () => { presence = p; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.p === p)) } },
    h('span', { class: 'presence-dot p-' + p }), PRESENCE_LABEL[p])))
  const btn = h('button', { class: 'btn', type: 'submit', text: 'Save profile' })
  const form = h('form', {
    class: 'settings-card',
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''
      const body = { name: name.value, presence, statusText: text.value, email: email.value }
      // the picture only travels when it changed (it is the big part)
      if (avatar !== original) body.avatar = avatar && avatar.startsWith('data:') ? avatar : ''
      btn.disabled = true
      try {
        const r = await api.put('/me/profile', body)
        state.me = r.user
        toast(r.changed ? 'Profile saved.' : 'Nothing changed.')
        render()
      } catch (ex) { err.textContent = ex.message } finally { btn.disabled = false }
    }
  },
    h('h2', { class: 'card-title', text: 'Your profile' }),
    h('div', { class: 'profile-pic-row' }, preview, h('div', null,
      h('label', { class: 'btn-ghost btn-small', for: 'p-file', tabindex: '0', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click() } } }, 'Upload picture'),
      ' ', h('button', { class: 'btn-ghost btn-small', type: 'button', onclick: () => { avatar = ''; paintAv() }, text: 'Remove' }),
      h('p', { class: 'card-note', text: 'Shrunk to a small square before it is saved.' })), file),
    h('div', { class: 'form-group' }, h('label', { for: 'p-name' }, 'Display name'), name),
    h('div', { class: 'form-group' }, h('label', null, 'Status'), seg),
    h('div', { class: 'form-group' }, h('label', { for: 'p-text' }, 'Status message'), text),
    h('div', { class: 'form-group' }, h('label', { for: 'p-email' }, 'Email ', h('span', { class: 'form-hint' }, '(for invite and reset links, if your company set up email)')), email),
    err, btn)
  return h('div', null, topbar({ back: '#/', title: 'Your profile', meta: ROLE_LABEL[u.role] + ' · @' + u.username }),
    h('main', { class: 'page narrow' }, form, h('p', { class: 'card-note' }, 'Want to see what your account has done? ', h('a', { href: '#/user/' + u.id }, 'Open your account log'), '.')))
}
