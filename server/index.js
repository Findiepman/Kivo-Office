const { PORT, APP_URL, isProduction, mailEnabled, TRUST_PROXY } = require('./config');
const db = require('./db');
const links = require('./links');
const sessions = require('./sessions');
const throttle = require('./throttle');
const { createApp } = require('./app');

const app = createApp();

const server = app.listen(PORT, (err) => {
  // Express 5 hands listen errors (port in use) to this callback
  if (err) {
    console.error(`Could not start on port ${PORT}: ${err.message}`);
    process.exit(1);
  }
  const port = server.address().port;
  console.log(`Kivo Office listening on http://localhost:${port}`);
  if (!APP_URL) console.log('APP_URL is not set: links are built from the address you open the app on, and no email is sent.');
  if (isProduction && !APP_URL) {
    console.log('WARNING: NODE_ENV=production without APP_URL. Set APP_URL to the https:// address people open.');
  } else if (isProduction && !APP_URL.startsWith('https://')) {
    console.log('WARNING: NODE_ENV=production with a non-https APP_URL. The session cookie is Secure, so sign-in only works over https.');
  }
  if (mailEnabled && !APP_URL) console.log('SMTP is configured but APP_URL is not, so invite and reset links are not emailed.');
  if (isProduction && TRUST_PROXY === false) {
    console.log('NODE_ENV=production without TRUST_PROXY: if a proxy or tunnel sits in front, set TRUST_PROXY so sign-in limits work per visitor.');
  }
  if (TRUST_PROXY === true) {
    console.log('TRUST_PROXY=true trusts every X-Forwarded-For hop, so a visitor can fake their address. Use TRUST_PROXY=1 (one proxy) instead.');
  }

  // First start: there is no default password. An empty install prints a
  // one-time setup link for the first IT admin instead (npm run setup-link
  // prints a fresh one later).
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (users === 0) {
    const issued = links.issue(null, null, 'setup');
    const link = links.buildLink(issued.token, links.localBase(port));
    console.log('');
    console.log('No accounts yet. Open this one-time link to create the first IT admin account:');
    console.log('');
    console.log('  ' + link);
    console.log('');
    console.log(`It works once and expires ${new Date(issued.expiresAt).toLocaleString()}. Restarting prints a new one.`);
  }
});

// Expired sessions and old sign-in counters are cleared hourly.
function housekeeping() {
  try {
    sessions.purgeExpired();
    throttle.purgeExpired();
  } catch (e) {
    console.error('Housekeeping failed:', e.message);
  }
}
housekeeping();
setInterval(housekeeping, 3600 * 1000).unref();

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // don't hang forever on a keep-alive connection
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
