const { isProduction, APP_URL } = require('../config');
// With APP_URL set, http visits go to its host, never to whatever Host
// header arrived.
const appHost = APP_URL ? new URL(APP_URL).host : null;

// No inline scripts or style attributes anywhere in public/, so the CSP can
// stay strict. Inline styles set through element.style (CSSOM) are allowed by
// CSP; only style="" in markup or setAttribute('style') is not, and the
// frontend never does that.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // fonts are self-hosted (public/fonts), so no visitor's address goes to Google
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function fromTrustedProxy(req) {
  const trust = req.app.get('trust proxy fn');
  return typeof trust === 'function' && !!trust(req.socket.remoteAddress, 0);
}

function securityHeaders(req, res, next) {
  // Behind Cloudflare a plain http:// visit arrives with X-Forwarded-Proto:
  // http. Send it to https before anything (a sign-in form) is served over an
  // unencrypted connection. Only when Express actually trusts the proxy this
  // request came through (TRUST_PROXY): otherwise req.protocol can't read
  // that header, stays 'http' even for https visitors, and every visit would
  // loop. The header itself must say http, not merely be present.
  const proto = String(req.get('X-Forwarded-Proto') || '').split(',')[0].trim().toLowerCase();
  if (isProduction && proto === 'http' && req.protocol === 'http' && fromTrustedProxy(req)) {
    const host = appHost || req.get('Host');
    const m = host ? /^[A-Za-z0-9.-]+(?::(\d{1,5}))?$/.exec(host) : null;
    if (m && (!m[1] || Number(m[1]) <= 65535)) {
      return res.redirect(308, `https://${host}${req.originalUrl}`);
    }
  }
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
}

module.exports = securityHeaders;
