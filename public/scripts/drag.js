// Drag (pointer events: mouse, pen and touch). A card is dropped on a status
// section; the target lights up, or turns red if the move isn't allowed.

let drag = null
let suppressClick = false

export const isDragStarted = () => !!(drag && drag.started)
export const clickSuppressed = () => suppressClick

function clearDropMarks() { document.querySelectorAll('.drop, .drop-no').forEach((n) => n.classList.remove('drop', 'drop-no')) }

export function endDrag(commit) {
  const d = drag; drag = null
  if (!d) return
  clearTimeout(d.timer)
  if (d.started) {
    d.ghost.remove(); d.row.classList.remove('drag-src'); document.body.classList.remove('dragging')
    clearDropMarks()
    suppressClick = true; setTimeout(() => { suppressClick = false }, 150)
    if (commit && d.to) d.onDrop(d.to)
  }
}

function startDrag(d, x, y) {
  if (!drag || drag !== d || d.started) return
  d.started = true
  const rect = d.row.getBoundingClientRect()
  d.offX = x - rect.left; d.offY = y - rect.top
  d.ghost = d.row.cloneNode(true)
  d.ghost.classList.add('drag-ghost'); d.ghost.removeAttribute('id'); d.ghost.removeAttribute('data-ctx'); d.ghost.style.width = rect.width + 'px'
  d.row.parentNode.append(d.ghost)
  d.row.classList.add('drag-src'); document.body.classList.add('dragging')
  moveGhost(d, x, y)
}

function moveGhost(d, x, y) {
  d.ghost.style.transform = 'translate(' + (x - d.offX) + 'px,' + (y - d.offY) + 'px)'
  const el = document.elementFromPoint(x, y)
  const sec = el && el.closest ? el.closest('.status-section') : null
  clearDropMarks()
  d.to = null
  if (sec) {
    const to = sec.dataset.status
    const m = d.canMove(to)
    if (to !== d.status) sec.classList.add(m.ok ? 'drop' : 'drop-no')
    if (m.ok) d.to = to
  }
  if (y < 70) window.scrollBy(0, -14); else if (y > window.innerHeight - 70) window.scrollBy(0, 14)
}

document.addEventListener('pointermove', (e) => {
  const d = drag; if (!d || e.pointerId !== d.pid) return
  if (e.pointerType === 'mouse' && e.buttons === 0) { endDrag(false); return } // button released outside the window
  const dist = Math.hypot(e.clientX - d.sx, e.clientY - d.sy)
  if (!d.started) {
    if (d.type === 'touch') { if (dist > 10) { clearTimeout(d.timer); drag = null } return } // finger moved first: it's a scroll
    if (dist > 5) startDrag(d, e.clientX, e.clientY)
    return
  }
  e.preventDefault()
  moveGhost(d, e.clientX, e.clientY)
})
document.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.pid) endDrag(true) })
document.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.pid) endDrag(false) })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag) endDrag(false) })
window.addEventListener('blur', () => endDrag(false))

// opts: { status, canMove(to) -> { ok }, onDrop(to) }
export function attachDrag(row, opts) {
  row.addEventListener('touchmove', (e) => { if (drag && drag.started) e.preventDefault() }, { passive: false })
  row.addEventListener('contextmenu', (e) => { if (drag && drag.started) e.preventDefault() })
  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (e.target.closest('button, a, input, .menu')) return
    endDrag(false)
    const d = { row, status: opts.status, canMove: opts.canMove, onDrop: opts.onDrop, sx: e.clientX, sy: e.clientY, pid: e.pointerId, type: e.pointerType, started: false, timer: null, to: null }
    drag = d
    // touch: hold briefly to pick the card up, so normal scrolling still works
    if (e.pointerType !== 'mouse') d.timer = setTimeout(() => { if (d.row.isConnected) startDrag(d, d.sx, d.sy); else if (drag === d) drag = null }, 280)
  })
}
