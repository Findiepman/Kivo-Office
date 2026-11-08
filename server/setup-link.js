// npm run setup-link [-- --force]
// Prints a fresh one-time link that creates a new IT admin account. Meant for
// the first start, or for when nobody can sign in as IT any more. Whoever runs
// this has shell access to the server, and so to the database anyway.
const { APP_URL, PORT } = require('./config');
const db = require('./db');
const links = require('./links');

const force = process.argv.includes('--force');

if (!links.needsSetup() && !force) {
  console.log('There is already an active IT admin who can sign in, so no setup link was made.');
  console.log('To add another IT admin, sign in as IT and use "Invite IT admin".');
  console.log('If you really need a setup link anyway, run: npm run setup-link -- --force');
  db.close();
  process.exit(1);
}

const issued = links.issue(null, null, 'setup');
const link = links.buildLink(issued.token, links.localBase(PORT));
console.log('One-time setup link for a new IT admin account (any older setup link stops working):');
console.log('');
console.log('  ' + link);
console.log('');
console.log(`It works once and expires ${new Date(issued.expiresAt).toLocaleString()}.`);
if (!APP_URL) console.log('APP_URL is not set, so the link uses localhost. Change the address part if you open Kivo Office elsewhere.');
db.close();
