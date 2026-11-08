import { h, clear, addAll, fmtTime, toast, dn } from '../dom.js'
import { api } from '../api.js'
import { state, go } from '../state.js'
import { brand } from '../layout.js'

// ---------- login ----------
export function pageLogin() {
  const err = h('p', { class: 'form-error', role: 'alert' })
  const un = h('input', { type: 'text', id: 'l-user', autocomplete: 'username', placeholder: 'your username', maxlength: 200 })
  const pw = h('input', { type: 'password', id: 'l-pass', autocomplete: 'current-password', placeholder: 'your password', maxlength: 200 })
  const btn = h('button', { class: 'btn auth-submit', type: 'submit' }, 'Sign in')
  const form = h('form', {
    class: 'auth-form',
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''
      btn.disabled = true
      try {
        const r = await api.login(un.value, pw.value)
        state.me = r.user
        go('#/')
      } catch (ex) { err.textContent = ex.message; pw.select() } finally { btn.disabled = false }
    }
  },
    h('div', { class: 'form-group' }, h('label', { for: 'l-user' }, 'Username'), un),
    h('div', { class: 'form-group' }, h('label', { for: 'l-pass' }, 'Password'), pw),
    err, btn)
  return h('div', { class: 'auth-body' }, h('div', { class: 'auth-card wide' },
    h('div', { class: 'auth-logo' }, brand()),
    h('h1', { class: 'auth-title' }, 'Welcome back'),
    h('p', { class: 'auth-subtitle' }, 'Sign in to your team\'s roadmaps'),
    form,
    h('p', { class: 'auth-note', text: 'Forgot your password? Ask your manager or IT admin for a reset link.' })))
}

// ---------- invite / reset / setup page (opened from a link, signed in or not) ----------
const REASON = {
  used: 'This link has already been used. Each link works once. If you forgot your password, ask your manager or IT admin for a new reset link.',
  expired: 'This link has expired. Links last 48 hours. Ask for a new one.',
  replaced: 'This link was cancelled or replaced. Use the latest link you were sent, or ask for a new one.',
  deactivated: 'This account has been deactivated.',
  unknown: 'We don\'t recognise this link. Check that you copied all of it, or ask for a new one.'
}

export function pageInvite(token) {
  const box = h('div', { class: 'auth-card wide' },
    h('div', { class: 'auth-logo' }, brand()),
    h('p', { class: 'auth-subtitle', text: 'Checking your link...' }))
  const wrap = h('div', { class: 'auth-body' }, box)
  api.linkInfo(token).then((info) => {
    const logo = box.firstChild; clear(box); box.append(logo)
    if (!info.valid) {
      box.append(h('h1', { class: 'auth-title', text: 'This link doesn\'t work' }), h('p', { class: 'auth-subtitle', text: REASON[info.reason] || REASON.unknown }),
        h('a', { class: 'btn auth-submit', href: '#/login' }, 'Go to sign in'))
      return
    }
    const setup = info.kind === 'setup'
    const cur = state.me
    const name = h('input', { type: 'text', id: 'i-name', maxlength: 40, autocomplete: 'name', placeholder: 'e.g. Ingrid Vos' })
    const un = h('input', { type: 'text', id: 'i-user', maxlength: 24, autocomplete: 'username', placeholder: 'e.g. ingrid' })
    const pw = h('input', { type: 'password', id: 'i-pw', autocomplete: 'new-password', placeholder: 'At least 10 characters', maxlength: 200 })
    const pw2 = h('input', { type: 'password', id: 'i-pw2', autocomplete: 'new-password', placeholder: 'Type it again', maxlength: 200 })
    const err = h('p', { class: 'form-error', role: 'alert' })
    const btn = h('button', { class: 'btn auth-submit', type: 'submit' }, setup ? 'Create my account' : info.kind === 'invite' ? 'Activate my account' : 'Save new password')
    const title = setup ? 'Set up Kivo Office' : info.kind === 'invite' ? 'Welcome, ' + info.name.split(' ')[0] : 'Set a new password'
    const sub = setup ? 'Create the IT admin account. You can invite managers and other IT admins once you are in.'
      : info.kind === 'invite' ? 'Choose a password to activate your account. Your username is ' + info.username + '.' : 'Choose a new password for ' + info.username + '.'
    addAll(box,
      h('h1', { class: 'auth-title', text: title }),
      h('p', { class: 'auth-subtitle', text: sub }),
      cur && (setup || cur.username !== info.username) ? h('p', { class: 'notice', text: 'You are signed in as ' + dn(cur) + '. Continuing will sign you out of that account.' }) : null,
      h('form', {
        class: 'auth-form',
        onsubmit: async (e) => {
          e.preventDefault(); err.textContent = ''
          if (pw.value !== pw2.value) { err.textContent = 'The two passwords don\'t match.'; return }
          if (pw.value.length < 10) { err.textContent = 'Password must be 10 to 200 characters.'; return }
          btn.disabled = true
          try {
            const data = { token, password: pw.value }
            if (setup) Object.assign(data, { name: name.value, username: un.value })
            const r = await api.useLink(data)
            state.me = r.user
            toast('Password set. You are signed in.')
            go('#/')
          } catch (ex) { err.textContent = ex.message } finally { btn.disabled = false }
        }
      },
        setup ? [h('div', { class: 'form-group' }, h('label', { for: 'i-name' }, 'Your name'), name),
          h('div', { class: 'form-group' }, h('label', { for: 'i-user' }, 'Username'), un)] : null,
        h('div', { class: 'form-group' }, h('label', { for: 'i-pw' }, setup ? 'Password' : 'New password'), pw),
        h('div', { class: 'form-group' }, h('label', { for: 'i-pw2' }, 'Repeat password'), pw2),
        err, btn),
      h('p', { class: 'auth-note', text: 'Only you ever see this password. Nobody at Kivo, not even IT, can read it. This link works once and expires ' + fmtTime(info.expiresAt) + '.' }))
    ;(setup ? name : pw).focus()
  }).catch(() => { clear(box); box.append(h('p', { class: 'form-error', text: 'Could not check this link.' })) })
  return wrap
}
