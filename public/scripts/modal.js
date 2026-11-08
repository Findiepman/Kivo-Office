import { h, svgIcon, ICON } from './dom.js'

// Stackable modals. They live outside #app, so a page re-render leaves an
// open dialog alone.
export const modals = []

export function openModal(opts) {
  const close = () => {
    const i = modals.indexOf(m); if (i < 0) return
    modals.splice(i, 1); m.el.remove()
    if (opts.onClose) opts.onClose()
    if (m.prevFocus && m.prevFocus.focus) try { m.prevFocus.focus() } catch (e) { /* gone */ }
  }
  const el = h('div', { class: 'modal open', onmousedown: (e) => { if (e.target === el) close() } },
    h('div', { class: 'modal-card' + (opts.small ? ' modal-small' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
      h('div', { class: 'modal-header' }, h('h3', { text: opts.title }),
        h('button', { class: 'btn-close', 'aria-label': 'Close', onclick: close }, svgIcon(ICON.close, 16))),
      h('div', { class: 'modal-body' }, opts.body),
      opts.footer ? h('div', { class: 'modal-footer' }, opts.footer(close)) : null))
  const m = { el, close, prevFocus: document.activeElement }
  modals.push(m)
  document.body.append(el)
  const f = el.querySelector('input:not([type=hidden]),textarea,select,.modal-footer .btn')
  if (f) f.focus()
  return close
}

export const closeAllModals = () => modals.slice().forEach((m) => m.close())

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modals.length) modals[modals.length - 1].close()
})

export function confirmBox(title, text, okLabel, onOk, danger) {
  openModal({
    title, small: true, body: h('p', { class: 'delete-warning', text }),
    footer: (close) => [
      h('button', { class: 'btn-ghost', onclick: close, text: 'Cancel' }),
      h('button', { class: danger ? 'btn-danger' : 'btn', text: okLabel, onclick: async () => { close(); await onOk() } })
    ]
  })
}
