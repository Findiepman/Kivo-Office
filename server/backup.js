// npm run backup
// Writes a consistent copy of the database to DATA_DIR/backups/. Safe to run
// while the server is up: SQLite's online backup copies a single snapshot,
// unlike copying the .db file by hand (which can miss what is still in -wal).
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('./config');
const db = require('./db');

const dir = path.join(DATA_DIR, 'backups');
fs.mkdirSync(dir, { recursive: true });

const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const file = path.join(dir, `kivo-office-${stamp}.db`);

db.backup(file)
  .then(() => {
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`Backup written: ${file} (${kb} KB)`);
    db.close();
  })
  .catch((e) => {
    console.error('Backup failed:', e.message);
    db.close();
    process.exit(1);
  });
