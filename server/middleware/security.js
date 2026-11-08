const { isProduction } = require('../config');

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

function securityHeaders(req, res, next) {
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
