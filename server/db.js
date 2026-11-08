const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { DATA_DIR } = require('./config');

// Everything the install needs lives in DATA_DIR: the database (with avatars
// inside it as data URLs) and the backups folder. Copying DATA_DIR plus .env
// moves the whole install.
fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'kivo-office.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Lets the setup-link and backup scripts work while the server holds the db.
db.pragma('busy_timeout = 5000');

// --- Migrations ---
// PRAGMA user_version records how many of these have run. Append new steps at
// the end; never edit one that has shipped, an existing db already ran it.
const MIGRATIONS = [
  // 1: initial schema
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('it', 'manager', 'member')),
    email TEXT NOT NULL DEFAULT '',
    -- NULL until the person opens their invite link and picks a password
    password_hash TEXT,
    avatar TEXT NOT NULL DEFAULT '',
    avatar_at INTEGER NOT NULL DEFAULT 0,
    presence TEXT NOT NULL DEFAULT 'available' CHECK (presence IN ('available', 'busy', 'away')),
    status_text TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    created_by INTEGER REFERENCES users(id),
    active INTEGER NOT NULL DEFAULT 1,
    deactivated_at INTEGER,
    deactivated_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    refreshed_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  -- invite, reset and first-start setup links. Only a SHA-256 of the token is kept.
  CREATE TABLE links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('invite', 'reset', 'setup')),
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_by INTEGER REFERENCES users(id),
    used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX idx_links_user ON links(user_id);

  CREATE TABLE roadmaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manager_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    creator_mode TEXT NOT NULL DEFAULT 'manager' CHECK (creator_mode IN ('everyone', 'manager', 'chosen')),
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    archived_by INTEGER REFERENCES users(id),
    deleted_at INTEGER,
    deleted_by INTEGER REFERENCES users(id)
  );
  CREATE INDEX idx_roadmaps_manager ON roadmaps(manager_id);

  CREATE TABLE roadmap_members (
    roadmap_id INTEGER NOT NULL REFERENCES roadmaps(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (roadmap_id, user_id)
  );
  CREATE INDEX idx_members_user ON roadmap_members(user_id);

  -- the chosen task handlers when creator_mode = 'chosen'
  CREATE TABLE roadmap_creators (
    roadmap_id INTEGER NOT NULL REFERENCES roadmaps(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (roadmap_id, user_id)
  );

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roadmap_id INTEGER NOT NULL REFERENCES roadmaps(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'finished')),
    tags TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_tasks_roadmap ON tasks(roadmap_id);

  CREATE TABLE task_assignees (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (task_id, user_id)
  );
  CREATE INDEX idx_assignees_user ON task_assignees(user_id);

  -- "needs a new assignee" markers left when someone was unassigned by a
  -- deactivation, a transfer or being removed from the roadmap
  CREATE TABLE task_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    reason TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX idx_flags_task ON task_flags(task_id);

  CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX idx_comments_task ON comments(task_id);

  -- No foreign keys on the two logs on purpose: an ON DELETE action would turn
  -- a task delete into an UPDATE here, which the triggers below refuse.
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor_id INTEGER,
    action TEXT NOT NULL,
    text TEXT NOT NULL,
    roadmap_id INTEGER,
    subject_id INTEGER,
    task_id INTEGER
  );
  CREATE INDEX idx_audit_actor ON audit_log(actor_id);
  CREATE INDEX idx_audit_subject ON audit_log(subject_id);
  CREATE INDEX idx_audit_roadmap ON audit_log(roadmap_id);

  CREATE TABLE password_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    user_id INTEGER,
    by_id INTEGER,
    kind TEXT NOT NULL
  );

  -- The database itself refuses to change history, whatever code runs against it.
  CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER password_log_no_update BEFORE UPDATE ON password_log
  BEGIN SELECT RAISE(ABORT, 'password_log is append-only'); END;
  CREATE TRIGGER password_log_no_delete BEFORE DELETE ON password_log
  BEGIN SELECT RAISE(ABORT, 'password_log is append-only'); END;
  -- INSERT OR REPLACE removes the old row without firing DELETE triggers
  -- (unless recursive_triggers is on), so reusing an id is refused up front.
  CREATE TRIGGER audit_log_no_replace BEFORE INSERT ON audit_log
  WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id)
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER password_log_no_replace BEFORE INSERT ON password_log
  WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM password_log WHERE id = NEW.id)
  BEGIN SELECT RAISE(ABORT, 'password_log is append-only'); END;

  -- failed sign-in counters per IP and per username (survive a restart)
  CREATE TABLE login_throttle (
    key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL,
    window_start INTEGER NOT NULL,
    locked_until INTEGER NOT NULL DEFAULT 0
  );
  `,
  // 2: a version stamp for "someone else changed this" checks on full saves
  `
  ALTER TABLE roadmaps ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  `,
];

function migrate() {
  const current = db.pragma('user_version', { simple: true });
  if (current > MIGRATIONS.length) {
    throw new Error(
      `The database was made by a newer Kivo Office (schema ${current}, this build knows ${MIGRATIONS.length}). ` +
        'Update the app instead of running an older version against it.'
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
migrate();

db.dbPath = dbPath;
module.exports = db;
