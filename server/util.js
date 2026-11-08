const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const now = () => Date.now();

// Same normalisers as the prototype's Core: one-line fields collapse
// whitespace, long fields keep line breaks. Non-strings become ''.
const clean = (s, max) => (typeof s === 'string' || typeof s === 'number' ? String(s) : '')
  .replace(/\s+/g, ' ').trim().slice(0, max);
const cleanLong = (s, max) => (typeof s === 'string' ? s : '')
  .replace(/\r/g, '').trim().slice(0, max);

const USERNAME_RE = /^[a-z0-9._-]{3,24}$/;
// Deliberately loose: the mail server is the real judge, this only stops junk.
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

const PW_MIN = 10;
const PW_MAX = 200;
const BCRYPT_COST = 12;

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

// bcrypt only reads the first 72 bytes, so a 200-character password would be
// cut short. Hashing it first (base64 of SHA-256 is 44 ASCII chars, no NUL
// bytes) keeps every character significant.
const prehash = (pw) => crypto.createHash('sha256').update(pw, 'utf8').digest('base64');
const hashPassword = (pw) => bcrypt.hash(prehash(pw), BCRYPT_COST);
const checkPassword = (pw, hash) => bcrypt.compare(prehash(pw), hash);
// Compared against when the username is unknown, so a wrong username takes as
// long as a wrong password and can't be told apart by timing.
const DUMMY_HASH = bcrypt.hashSync(prehash(crypto.randomBytes(16).toString('hex')), BCRYPT_COST);

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= PW_MIN && pw.length <= PW_MAX;
}

// Route ids: positive integers only, anything else is "not found".
function toId(v) {
  // anything else (an object with its own toString, an array) is refused
  // before Number() could run user-supplied conversion code
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 && String(n) === String(v) ? n : null;
}

const plural = (n, a, b) => n + ' ' + (n === 1 ? a : b);

module.exports = {
  now, clean, cleanLong, USERNAME_RE, EMAIL_RE, PW_MIN, PW_MAX,
  sha256, randomToken, hashPassword, checkPassword, DUMMY_HASH, validPassword, toId, plural,
};
