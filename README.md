# Kivo Office

A self-hosted kanban roadmap tool for one company per install. IT admins invite managers, managers invite their team and run roadmaps, everyone works on the tasks assigned to them, and an append-only audit log records every action.

It is a small Node app (Express, SQLite through better-sqlite3, bcryptjs) with a plain HTML/CSS/JavaScript frontend. The whole state of an install is one SQLite file in `data/`.

The approved clickable prototype that this app is built from is kept in [`prototype/kivo-office.html`](prototype/kivo-office.html). Its screenshots are in [`docs/screenshots`](docs/screenshots).

## What it does

- **Accounts:** IT admin, Manager and Team member. IT invites managers and other IT admins; managers invite team members. Nobody hands out passwords: every new account gets a one-time **invite link** (48 hours, single use, a newer link replaces an older one), and forgotten passwords get a **reset link** that only replaces the old password once it is used.
- **Roadmaps:** each has an owner (the manager who made it) and people on it, from any team. Per roadmap the owner picks who creates tasks: everyone, the owner only, or the owner plus chosen task handlers.
- **Tasks:** only assigned people edit a task or change its status. Status only moves forward (Planned, In progress, Finished, skipping ahead is fine) and every move asks for confirmation. Only the roadmap owner can move a task back, and that is logged as an override. List and board views, with drag and drop (mouse, and a short hold on touch screens) and a right-click / long-press menu.
- **No lost changes:** if someone changed a task or a roadmap's settings while you had it open, saving tells you to reload instead of overwriting their change.
- **Comments:** anyone on the roadmap comments. You delete your own; the roadmap owner and IT delete any. The log notes the deletion, never the text.
- **Profiles:** picture and status (available, busy, away, plus a short message).
- **Deactivate, never delete:** a deactivated person is signed out everywhere at once and can't sign in. Their open tasks are unassigned and flagged for the roadmap owner. A manager who still owns roadmaps or team members has to be transferred to another manager first (IT does that in one step). The last IT admin can't be deactivated. If IT deactivated someone, only IT can bring them back.
- **Archive** a roadmap (owner or IT) to make it read-only everywhere. **Delete** only hides it: IT still sees it, with its log, under Deleted roadmaps.
- **Logs:** the activity log (IT), the password log (IT: who issued which link, and when it was used), a log per roadmap (IT and the owner) and per account. All of them can be filtered and paged.

## Run it

You need Node.js 22 or newer.

```bash
npm install
cp .env.example .env      # then edit it, see below
npm start
```

For development, `npm run dev` restarts on every change. The example `.env` works as it is for a local run on `http://localhost:3000`. For a real install set `NODE_ENV=production` and an `https://` `APP_URL`; the server warns on start when production runs without them.

### First start

There is no default account and no default password. When the database has no accounts, the server prints a one-time **setup link** on its console:

```
No accounts yet. Open this one-time link to create the first IT admin account:

  https://kivo.example.com/#/invite/...
```

Open it, choose your name, username and password, and you are the first IT admin. The link works once and expires after 48 hours; every restart of an empty install prints a fresh one.

If nobody can sign in as IT any more, run `npm run setup-link` on the server for a new link. While an IT admin can still sign in it refuses; `npm run setup-link -- --force` makes one anyway (whoever runs it has access to the server and its database already).

### With Docker

```bash
cp .env.example .env      # fill in APP_URL, and the tunnel token if you use it
docker compose up -d --build
docker compose logs app   # shows the setup link on the first start
```

The app is published on `127.0.0.1:3000` only (change the port with `HOST_PORT` in `.env`). Compose passes the app only the settings it reads, and always sets `TRUST_PROXY=1`, since a proxy or the tunnel sits in front. The cloudflared image is pinned to a version; bump it by hand. To reach it from outside, use the included Cloudflare tunnel (`docker compose --profile tunnel up -d`, with `CLOUDFLARE_TUNNEL_TOKEN` in `.env` and the tunnel pointed at `http://app:3000`) or your own HTTPS reverse proxy. Data lives in `./data` next to the compose file.

Scripts inside the container run as the `node` user:

```bash
docker compose exec -u node app npm run setup-link
docker compose exec -u node app npm run backup
```

## Settings (`.env`)

| Variable | What it does |
|---|---|
| `PORT` | Port to listen on with `npm start`. Default `3000`. Fixed to `3000` inside Docker. |
| `HOST_PORT` | Docker only: the port on this machine (127.0.0.1) that reaches the app. Default `3000`. |
| `NODE_ENV` | `production` makes the session cookie `Secure` (HTTPS only) and adds HSTS. |
| `APP_URL` | The address people open, e.g. `https://kivo.example.com`. Invite and reset links are built from it. Without it the copy box uses the address in your browser and nothing is emailed. Always set it behind a proxy that rewrites the `Host` header, or every change is refused by the cross-site check. |
| `DATA_DIR` | Where the database and backups go. A relative path is taken relative to the project folder (where `package.json` is), not the folder you start from. Default `data`. Fixed to `/app/data` inside Docker (the `./data` folder next to `docker-compose.yml`). |
| `TRUST_PROXY` | Set to `1` when one proxy or tunnel (like cloudflared) sits in front, so sign-in limits count real visitors, not the proxy. `docker-compose.yml` always sets `1`. Accepts what Express's `trust proxy` accepts; avoid `true`, which lets visitors fake their address. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Optional. With all five (and `APP_URL`) set, invite and reset links are also emailed to the account's email address. Port 465 uses TLS directly; other ports must upgrade with STARTTLS or nothing is sent. |
| `CLOUDFLARE_TUNNEL_TOKEN` | Only for the optional tunnel in `docker-compose.yml`. It is passed to the cloudflared container only, never to the app. |

Email addresses are optional: the inviter can fill one in, and people can set their own on their profile page.

## Backups and moving to another server

Everything is in `DATA_DIR` (default `data/` in the project folder): one SQLite database `kivo-office.db` that holds all accounts, roadmaps, tasks, comments, profile pictures and logs. Secrets are in `.env`.

**Backup:** `npm run backup` writes a consistent copy to `data/backups/kivo-office-YYYYMMDD-HHMMSS.db`. It is safe to run while the app is running. Copy those files somewhere else (another disk, another machine) regularly; a backup that only lives next to the original doesn't survive a dead disk.

**Restore:** stop the app, replace `data/kivo-office.db` with a backup file (and delete `kivo-office.db-wal` and `kivo-office.db-shm` if they are there), start the app.

**Move the install to another server:**

1. Stop the app on the old server (`docker compose down`, or stop `npm start`). Stopping first matters: it makes sure everything is written into the database file.
2. Copy the whole `data/` folder and the `.env` file to the new server, next to a fresh checkout of this repository.
3. If the address changes, update `APP_URL` in `.env` (and point the tunnel or DNS at the new server).
4. Start it there (`docker compose up -d --build`, or `npm install` and `npm start`). Everyone keeps their accounts; they only need to sign in again if the address changed.

## Security notes

- The server enforces every rule; the pages only hide buttons you can't use. Refused attempts are logged.
- **Sessions:** a random token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` in production), stored only as a SHA-256 hash, with a 12-hour sliding expiry and a hard limit of 7 days after sign-in. Logging out deletes the session on the server. The account is loaded from the database on every request, so a deactivation or password reset takes effect immediately and ends all of that person's sessions.
- **CSRF:** besides `SameSite=Strict`, every change needs an `X-Kivo` request header and, when the browser sends an `Origin`, it must be this site.
- **Passwords:** 10 to 200 characters, stored with bcrypt (cost 12). Typed passwords are never logged. A failed sign-in only logs the username when the input looks like a username and belongs to a real account (a password typed into the username box often looks like a username too).
- **Sign-in limits** (each lock lasts 15 minutes; failures count within a 15-minute window):
  - 8 failed attempts for one username from one address lock that username from that address only. Someone else can't keep you locked out from your own desk.
  - 100 failed attempts for one username, from any mix of addresses, lock that username everywhere. This is a brake against wide password guessing.
  - 8 failed attempts from one address, whatever usernames, lock that address. IPv6 addresses count per /64 network, which is what one home or office usually gets.
  - Failures and lockouts for real accounts are logged. Attempts on usernames that don't exist are counted but not logged, so made-up names can't grow the append-only log.
  - Behind a proxy, set `TRUST_PROXY` (see above; `docker-compose.yml` already does), otherwise everyone shares one address. A whole office behind one public IP also shares that address limit.
- **Links:** invite, reset and setup tokens are 32 random bytes. Only their SHA-256 is stored, they work once, expire after 48 hours, and travel in the URL fragment (`#/invite/...`), which browsers never send to a server.
- **Audit log:** append-only, enforced by the database itself: triggers refuse any `UPDATE`, `DELETE` or `REPLACE` on the activity and password logs.
- **Input:** everything is validated and length-capped, SQL is always parameterised, and the frontend only ever inserts user text as text, never as HTML. Profile pictures are shrunk in the browser and checked again on the server (JPEG, PNG or WebP only, at most 100 KB, and the file's first bytes must match its type).
- **Headers:** a strict Content-Security-Policy without inline scripts, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `frame-ancestors 'none'`.
- **Fonts** (Bricolage Grotesque and Instrument Sans, SIL Open Font License, licences in `public/fonts/`) are served by the app itself, so no visitor's address goes to Google or any other third party.
- **Profile pictures** are only shown to people who may see that profile (IT, the person's manager, and people sharing a roadmap with them); everyone else gets the initials. Accounts you can't see answer exactly like accounts that don't exist.

## Tests

```bash
npm test
```

The tests start the real server on a random port with a temporary data folder and use it over HTTP, the way a browser does. They cover the invite and reset flows, task and comment permissions, archiving, deactivation and transfers, the audit log triggers, CSRF, sign-in lockouts and that no password ends up in the database or the server output.

## License

Source-available, **not** open source. You may read the code, run it locally and contribute back through pull requests, but you may not redistribute, host or reuse it elsewhere. See [LICENSE](LICENSE).
