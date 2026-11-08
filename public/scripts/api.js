// Every request goes to our own origin with the session cookie. The X-Kivo
// header is what the server's CSRF check looks for on every write.

let onSignedOut = () => {}
export function setSignedOutHandler(fn) { onSignedOut = fn }

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

async function request(method, path, body, opts = {}) {
  const headers = { 'X-Kivo': '1' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let res
  try {
    res = await fetch('/api' + path, {
      method,
      headers,
      credentials: 'same-origin',
      // a stalled tunnel must not hang forever: run() holds its in-flight guard until this settles
      signal: AbortSignal.timeout(30000),
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch (e) {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0)
  }
  let data = null
  const text = await res.text()
  if (text) { try { data = JSON.parse(text) } catch (e) { data = null } }
  // The session ended (expired, logged out elsewhere, deactivated): back to
  // the sign-in page. Skipped for sign-in itself so its error can show.
  if (res.status === 401 && !opts.allow401) {
    onSignedOut()
    throw new ApiError((data && data.error) || 'Please sign in.', 401)
  }
  if (!res.ok) throw new ApiError((data && data.error) || 'Something went wrong.', res.status)
  return data
}

const q = (params) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) if (v !== '' && v != null) s.set(k, v)
  const t = s.toString()
  return t ? '?' + t : ''
}

export const api = {
  get: (path, params) => request('GET', path + q(params)),
  post: (path, body) => request('POST', path, body === undefined ? {} : body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),

  session: () => request('GET', '/auth/session'),
  login: (username, password) => request('POST', '/auth/login', { username, password }, { allow401: true }),
  logout: () => request('POST', '/auth/logout', {}, { allow401: true }),
  linkInfo: (token) => request('POST', '/links/info', { token }, { allow401: true }),
  useLink: (data) => request('POST', '/links/use', data, { allow401: true })
}
