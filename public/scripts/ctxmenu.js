import { h } from './dom.js'
import { isDragStarted, endDrag } from './drag.js'

// Right-click / long-press menu: one shared element, listeners registered
// once. Pages register, per data-ctx key ("task:12"), a function returning
// the items the current user may do; the server re-checks every action.
const providers = new Map()
export const registerCtx = (key, itemsFn) => { providers.set(key, itemsFn) }
const itemsFor = (key) => {
  const fn = providers.get(key)
  try { return fn ? fn().filter(Boolean) : [] } catch (e) { return [] }
}

const ctxState = { el: null, prev: null, swallowUntil: 0, timer: null, sx: 0, sy: 0, pid: -1 }

export function closeCtx() {
  const el = ctxState.el
  if (!el) return
  ctxState.el = null; el.remove()
  const p = ctxState.prev; ctxState.prev = null
  if (p && p.isConnected && p.focus) try { p.focus({ preventScroll: true }) } catch (e) { /* gone */ }
}

function openCtx(x, y, items) {
  closeCtx()
  const list = items.filter(Boolean)
  const el = h('div', { class: 'ctx-menu', role: 'menu', 'aria-label': 'Actions', tabindex: '-1' })
  if (!list.length) el.append(h('div', { class: 'ctx-empty', text: 'No actions available' }))
  list.forEach((it) => {
    if (it.sep) { el.append(h('div', { class: 'ctx-sep', role: 'separator' })); return }
    el.append(h('button', {
      class: 'ctx-item' + (it.danger ? ' danger' : ''), type: 'button', role: 'menuitem', tabindex: '-1', text: it.label,
      onclick: () => { closeCtx(); it.onclick() }
    }))
  })
  el.addEventListener('keydown', (e) => {
    const btns = [...el.querySelectorAll('.ctx-item')]
    const i = btns.indexOf(document.activeElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCtx() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (btns.length) btns[(i + 1) % btns.length].focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (btns.length) btns[(i - 1 + btns.length) % btns.length].focus() }
    else if (e.key === 'Home') { e.preventDefault(); if (btns.length) btns[0].focus() }
    else if (e.key === 'End') { e.preventDefault(); if (btns.length) btns[btns.length - 1].focus() }
    else if (e.key === 'Tab') { e.preventDefault(); closeCtx() }
  })
  ctxState.prev = document.activeElement
  document.body.append(el)
  ctxState.el = el
  // keep it inside the viewport
  const w = el.offsetWidth, hh = el.offsetHeight, m = 8
  el.style.left = Math.max(m, Math.min(x, window.innerWidth - w - m)) + 'px'
  el.style.top = Math.max(m, Math.min(y, window.innerHeight - hh - m)) + 'px'
  ;(el.querySelector('.ctx-item') || el).focus({ preventScroll: true })
}

function ctxTarget(el) {
  const n = el && el.closest ? el.closest('[data-ctx]') : null
  if (!n) return null
  return { node: n, key: n.getAttribute('data-ctx') }
}
const isEditable = (el) => !!(el && el.closest && el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))

document.addEventListener('contextmenu', (e) => {
  if (e.defaultPrevented) return // e.g. a touch drag in progress
  const tg = ctxTarget(e.target)
  if (!tg || isEditable(e.target)) { closeCtx(); return }
  const sel = window.getSelection ? window.getSelection() : null
  // selected text inside this item: leave the browser's menu (copy etc.)
  if (sel && sel.toString().trim() && sel.anchorNode && tg.node.contains(sel.anchorNode)) { closeCtx(); return }
  const items = itemsFor(tg.key)
  // nothing this user may do here: never an empty menu, leave the browser's
  if (!items.some((it) => !it.sep)) { closeCtx(); return }
  e.preventDefault()
  // Android fires its own long-press contextmenu (~500 ms) before our 650 ms
  // timer: one menu is enough
  clearTimeout(ctxState.timer); ctxState.timer = null
  openCtx(e.clientX, e.clientY, items)
})
document.addEventListener('pointerdown', (e) => {
  if (ctxState.el && !ctxState.el.contains(e.target)) closeCtx()
  clearTimeout(ctxState.timer); ctxState.timer = null
  // Touch long-press. On a card you can drag, the 280 ms hold picks it up; keeping the finger still until 650 ms
  // turns that into this menu instead. Moving the finger always means drag or scroll, never the menu.
  if (e.pointerType !== 'touch' || isEditable(e.target)) return
  const tg = ctxTarget(e.target); if (!tg) return
  ctxState.sx = e.clientX; ctxState.sy = e.clientY; ctxState.pid = e.pointerId
  ctxState.timer = setTimeout(() => {
    ctxState.timer = null
    const items = itemsFor(tg.key)
    if (!items.some((it) => !it.sep)) return // nothing allowed: no empty menu
    if (isDragStarted()) endDrag(false)
    ctxState.swallowUntil = Date.now() + 700
    openCtx(ctxState.sx, ctxState.sy, items)
  }, 650)
}, true)
document.addEventListener('pointermove', (e) => {
  if (ctxState.timer && e.pointerId === ctxState.pid && Math.hypot(e.clientX - ctxState.sx, e.clientY - ctxState.sy) > 10) { clearTimeout(ctxState.timer); ctxState.timer = null }
}, true)
;['pointerup', 'pointercancel'].forEach((n) => document.addEventListener(n, () => { clearTimeout(ctxState.timer); ctxState.timer = null }, true))
// the click that follows a long-press must not also open the item
document.addEventListener('click', (e) => { if (Date.now() < ctxState.swallowUntil) { e.preventDefault(); e.stopPropagation() } }, true)
// Escape always closes the menu, whatever has focus
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ctxState.el) { e.preventDefault(); e.stopPropagation(); closeCtx() }
}, true)
window.addEventListener('scroll', closeCtx, true)
window.addEventListener('resize', closeCtx)
window.addEventListener('blur', closeCtx)
