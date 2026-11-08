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
  APP_URL,
  NODE_ENV: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  DATA_DIR: path.resolve(rootDir, process.env.DATA_DIR || 'data'),
  TRUST_PROXY: parseTrustProxy(process.env.TRUST_PROXY),
  smtp,
  mailEnabled: !!(smtp.host && smtp.port && smtp.user && smtp.pass && smtp.from),
};
