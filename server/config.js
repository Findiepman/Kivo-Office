const path = require('path');

// quiet: dotenv 17+ prints a banner on every load, which would end up in the
// setup-link and backup script output.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const rootDir = path.join(__dirname, '..');

function parseTrustProxy(v) {
  if (v == null || v === '' || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // express also accepts 'loopback', subnets, comma lists
}

// PORT=0 is allowed (the tests ask the OS for a free port).
const rawPort = Number(process.env.PORT);
const PORT = process.env.PORT && Number.isInteger(rawPort) && rawPort >= 0 ? rawPort : 3000;

// Empty = every interface (Node's default, and what Docker needs inside the
// container). 127.0.0.1 keeps a plain npm start behind a tunnel or proxy off
// the local network, where it would otherwise answer over plain http.
const HOST = (process.env.BIND_HOST || '').trim();

// APP_URL is the public address people open (https://kivo.example.com). Links
// in emails are only ever built from it, never from a request's Host header,
// so a forged Host can't redirect someone's invite token elsewhere.
let APP_URL = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
if (APP_URL) {
  try {
    const u = new URL(APP_URL);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    APP_URL = u.origin + u.pathname.replace(/\/+$/, '');
  } catch (e) {
    console.error(`APP_URL "${APP_URL}" is not a valid http(s) URL. Ignoring it.`);
    APP_URL = '';
  }
}

// Changes (POST/PUT/PATCH/DELETE) one signed-in account may make per minute.
// Far above what clicking around produces; stops a script flooding the
// database. 0 turns the limit off.
const rawWrites = Number(process.env.WRITE_LIMIT_PER_MINUTE);
const WRITE_LIMIT_PER_MINUTE = process.env.WRITE_LIMIT_PER_MINUTE && Number.isInteger(rawWrites) && rawWrites >= 0 ? rawWrites : 120;

const smtp = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT) || 0,
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.MAIL_FROM || '',
};

module.exports = {
  rootDir,
  PORT,
  HOST,
  APP_URL,
  NODE_ENV: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  DATA_DIR: path.resolve(rootDir, process.env.DATA_DIR || 'data'),
  TRUST_PROXY: parseTrustProxy(process.env.TRUST_PROXY),
  // Cloudflare's CF-Connecting-IP is always exactly the visitor. Only safe to
  // trust when nothing but Cloudflare can reach the app (BIND_HOST=127.0.0.1
  // behind cloudflared); anywhere else a visitor could send it themselves.
  TRUST_CF_CONNECTING_IP: process.env.TRUST_CF_CONNECTING_IP === '1',
  WRITE_LIMIT_PER_MINUTE,
  smtp,
  mailEnabled: !!(smtp.host && smtp.port && smtp.user && smtp.pass && smtp.from),
};
