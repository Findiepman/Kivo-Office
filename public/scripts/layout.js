import { h, svgIcon, ICON, avatarEl, emptyState } from './dom.js'
import { api } from './api.js'
import { state, go } from './state.js'

export const brand = () => ['Kivo', h('span', { class: 'brand-dot' }, '.'), h('span', { class: 'brand-sub' }, ' Office')]

export function topbar(o) {
  const u = state.me; o = o || {}
  const left = o.back
    ? [h('a', { class: 'icon-link', href: o.back, title: 'Back', 'aria-label': 'Back' }, svgIcon(ICON.back, 18)),
        h('div', { class: 'board-title' }, h('h1', { text: o.title }), o.meta ? h('p', { class: 'roadmap-meta', text: o.meta }) : null)]
    : [h('a', { class: 'brand', href: '#/' }, brand())]
  const nav = []
  if (u && !o.back) {
    nav.push(h('a', { class: 'navlink' + (o.active === 'home' ? ' on' : ''), href: '#/' }, u.role === 'it' ? 'Dashboard' : 'Roadmaps'))
    if (u.role === 'manager') nav.push(h('a', { class: 'navlink' + (o.active === 'team' ? ' on' : ''), href: '#/team' }, 'My team'))
    if (u.role === 'it') {
      nav.push(h('a', { class: 'navlink' + (o.active === 'log' ? ' on' : ''), href: '#/log' }, 'Activity'))
      nav.push(h('a', { class: 'navlink' + (o.active === 'pw' ? ' on' : ''), href: '#/passwords' }, 'Password log'))
    }
  }
  return h('header', { class: 'topbar' },
    h('div', { class: 'topbar-left' }, left, nav.length ? h('nav', { class: 'nav' }, nav) : null),
    h('div', { class: 'topbar-right' }, o.right || [],
      u ? [
        h('a', { class: 'user-chip', href: '#/profile', title: 'Your profile' }, avatarEl(u, '', true), h('span', { class: 'chip-name', text: u.name })),
        h('button', {
          class: 'btn-ghost btn-small',
          text: 'Log out',
          onclick: async () => {
            try { await api.logout() } catch (e) { /* the session is gone either way */ }
            state.me = null
            go('#/login')
          }
        })
      ] : null))
}

export function pageMissing(text) {
  return h('div', null, topbar({}), h('main', { class: 'page' }, emptyState('Nothing to see here', text,
    h('div', { class: 'missing-actions' }, h('a', { class: 'btn', href: '#/' }, 'Back to start')))))
}
