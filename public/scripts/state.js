import { toast } from './dom.js'

// Shared app state. The router registers itself here so pages can ask for a
// re-render without importing app.js (which imports them).
export const state = { me: null }

let renderFn = async () => {}
export function setRender(fn) { renderFn = fn }
export const render = () => renderFn()

export const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash }

// Wraps an action: shows the error as a toast, always re-renders. Resolves to
// the action's result (true when it returned nothing) or undefined on error.
// One at a time: a double click on Unarchive, Reactivate and the like is
// ignored while the first click is still on its way.
let inflight = false
export async function run(fn, okMsg) {
  if (inflight) return undefined
  inflight = true
  try {
    const r = await fn()
    if (okMsg) toast(okMsg)
    await render()
    return r === undefined ? true : r
  } catch (e) {
    if (!e || e.status !== 401) toast(e && e.message ? e.message : 'Something went wrong.', true)
    await render()
    return undefined
  } finally {
    inflight = false
  }
}
