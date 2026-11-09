// Test harness: starts the real server as a child process on a random port
// with its own temporary DATA_DIR, and talks to it with fetch, the same way a
// browser does (cookie, X-Kivo header).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'index.js');

function baseEnv(dataDir, extra) {
  // Every setting the server reads is set explicitly, so a developer's .env
  // (dotenv never overrides what is already set) can't leak into a test run,
  // and nothing is ever emailed from one.
  return Object.assign({}, process.env, {
    PORT: '0',
    BIND_HOST: '',
    DATA_DIR: dataDir,
    NODE_ENV: 'test',
    APP_URL: '',
    TRUST_PROXY: '',
    SMTP_HOST: '',
    SMTP_PORT: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    MAIL_FROM: '',
  }, extra || {});
}

function tmpDir() {
  const parent = process.env.KIVO_TEST_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, 'kivo-test-'));
}

async function startServer(opts = {}) {
  const dataDir = opts.dataDir || tmpDir();
  const child = spawn(process.execPath, [SERVER], { env: baseEnv(dataDir, opts.env), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + out)), 15000);
    let seen = false;
    const check = () => {
      const m = /listening on http:\/\/localhost:(\d+)/.exec(out);
      if (!m || seen) return;
      seen = true;
      // the setup link (if any) is printed in the same tick right after the
      // listening line, but may arrive in a later pipe chunk
      setTimeout(() => { clearTimeout(timer); resolve(Number(m[1])); }, 250);
    };
    child.stdout.on('data', check);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('server exited ' + code + ':\n' + out)); });
  });
  const base = `http://localhost:${port}`;
  const m = /#\/invite\/([A-Za-z0-9_-]+)/.exec(out);
  return {
    base,
    port,
    dataDir,
    setupToken: m ? m[1] : null,
    output: () => out,
    client: () => new Client(base),
    db: () => new Database(path.join(dataDir, 'kivo-office.db')),
    async stop(keep) {
      if (child.exitCode === null) {
        await new Promise((resolve) => {
          child.once('exit', resolve);
          child.kill();
        });
      }
      if (!keep) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

class Client {
  constructor(base) {
    this.base = base;
    this.cookie = null;
    this.ip = null; // X-Forwarded-For, only honoured when the server runs with TRUST_PROXY
  }

  async req(method, p, body, opts = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.csrf !== false) headers['X-Kivo'] = '1';
    if (opts.origin) headers.Origin = opts.origin;
    if (this.ip) headers['X-Forwarded-For'] = this.ip;
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await fetch(this.base + p, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const setCookies = res.headers.getSetCookie();
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const value = pair.slice(i + 1);
      this.cookie = value ? pair : null;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, body: json, text, headers: res.headers, setCookies };
  }

  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b, o) { return this.req('POST', p, b === undefined ? {} : b, o); }
  put(p, b, o) { return this.req('PUT', p, b, o); }
  patch(p, b, o) { return this.req('PATCH', p, b, o); }
  del(p, o) { return this.req('DELETE', p, undefined, o); }
}

const pw = (name) => `pw-${name}-Correct-Horse`;

// Uses a link token as a fresh browser; returns the signed-in client.
async function useLink(srv, token, password, extra) {
  const c = srv.client();
  const r = await c.post('/api/links/use', Object.assign({ token, password }, extra || {}));
  if (r.status !== 200) throw new Error('link use failed: ' + r.status + ' ' + r.text);
  return c;
}

async function invite(by, role, name, username, email) {
  const r = await by.post('/api/users', { role, name, username, email });
  if (r.status !== 201) throw new Error(`invite ${username} failed: ${r.status} ${r.text}`);
  return r.body;
}

// The prototype's demo company: IT Ingrid (+ Dina), managers Marta and Omar,
// Marta's team Lena, Tom, Sofia and Omar's team Ravi, Noor. Everyone signed in.
async function buildWorld(srv, opts = {}) {
  const c = {};
  const ids = {};
  c.ingrid = await useLink(srv, srv.setupToken, pw('ingrid'), { name: 'Ingrid Vos', username: 'ingrid' });
  ids.ingrid = (await c.ingrid.get('/api/auth/me')).body.user.id;
  const add = async (by, role, name, username) => {
    const r = await invite(c[by], role, name, username);
    ids[username] = r.user.id;
    c[username] = await useLink(srv, r.token, pw(username));
  };
  if (opts.dina !== false) await add('ingrid', 'it', 'Dina Alvarez', 'dina');
  await add('ingrid', 'manager', 'Marta Jansen', 'marta');
  await add('ingrid', 'manager', 'Omar Haddad', 'omar');
  for (const [n, u] of [['Lena Marsh', 'lena'], ['Tom Bakker', 'tom'], ['Sofia Rossi', 'sofia']]) await add('marta', 'member', n, u);
  for (const [n, u] of [['Ravi Patel', 'ravi'], ['Noor Hassan', 'noor']]) await add('omar', 'member', n, u);
  return { c, ids };
}

// Each call comes from its own made-up address (used when the server runs
// with TRUST_PROXY), so unrelated tests don't add up to an IP lockout.
let ipCounter = 0;
async function login(srv, username, password) {
  const c = srv.client();
  ipCounter++;
  c.ip = '10.77.' + Math.floor(ipCounter / 250) + '.' + ((ipCounter % 250) + 1);
  const r = await c.post('/api/auth/login', { username, password: password || pw(username) });
  return { c, r };
}

function lastLogs(srv, n = 20) {
  const d = srv.db();
  try {
    return d.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(n);
  } finally {
    d.close();
  }
}

function allLogText(srv) {
  const d = srv.db();
  try {
    return d.prepare('SELECT text FROM audit_log').all().map((r) => r.text).join('\n');
  } finally {
    d.close();
  }
}

module.exports = { startServer, Client, pw, useLink, invite, buildWorld, login, lastLogs, allLogText, ROOT, baseEnv };
