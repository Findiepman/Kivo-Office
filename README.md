# Kivo Office

Kanban roadmaps for a whole company. IT admins invite managers, managers invite their team and run roadmaps, everyone works on the tasks assigned to them, and an append-only log records every action.

One company per install. A small Node server (Express, SQLite) with a plain HTML/CSS/JavaScript frontend.

## Screenshots

These are from the approved clickable prototype ([`prototype/kivo-office.html`](prototype/kivo-office.html)) that the app is built from, so they show fake demo people and roadmaps. The prototype's login screen has a demo account switcher; the real app doesn't.

| | |
|---|---|
| ![Login](docs/screenshots/01-login.png) | ![Manager roadmaps](docs/screenshots/02-manager-roadmaps.png) |
| Login (prototype, with the demo switcher) | A manager's roadmaps |
| ![Roadmap list](docs/screenshots/03-roadmap-list.png) | ![Roadmap board](docs/screenshots/04-roadmap-board.png) |
| Roadmap, list view | Roadmap, board view |
| ![My team](docs/screenshots/05-my-team.png) | ![IT dashboard](docs/screenshots/06-it-dashboard.png) |
| A manager's team | IT admin dashboard |
| ![Activity log](docs/screenshots/07-activity-log.png) | ![Password log](docs/screenshots/08-password-log.png) |
| Append-only activity log | Password log (invite and reset links) |

## How it works

### Three kinds of accounts

- **IT admins** look after the install. Their dashboard lists every roadmap on the left and every manager on the right, with the team members each manager invited nested underneath, plus a panel with the other IT admins. IT can open and comment on every roadmap (so they can help someone who is stuck), but doesn't edit tasks.
- **Managers** invite their team, create roadmaps and decide who works on what.
- **Team members** work on the tasks assigned to them and comment on the rest.

### Joining: invite links, no handed-out passwords

Nobody ever picks a password for someone else. IT invites managers and other IT admins; a manager invites team members from **My team**. Each invite produces a one-time link, shown once in a copy box (and emailed too, when the install has email set up). The new person opens it, chooses their own password and is signed in.

Links work once and expire after 48 hours. Issuing a new link cancels the old one. A forgotten password works the same way: **Send reset link** gives the person a link to choose a new one, and their old password keeps working until they use it. Using a reset link signs them out everywhere else.

The very first IT admin of a new install gets their link from the server itself; there is no default account or password.

### Roadmaps and roles

A roadmap belongs to the manager who created it (its owner). The owner can put anyone on it, from their own team or someone else's, other managers included. In the roadmap's **Settings** the owner also chooses who may create tasks:

- **Everyone on the roadmap**
- **Manager only**
- **Manager + chosen task handlers**, people the owner picks to create and hand out tasks

### Tasks

Each task has a status: **Planned**, **In progress** or **Finished**.

- Only the people a task is assigned to can edit it or change its status. Everyone else on the roadmap can read it and comment.
- Status only moves forward (skipping ahead is fine), and every move asks you to confirm, because it can't be undone. Only the roadmap's owner can move a task back, for example to reopen it, and that shows up in the log as an override.
- Switch between **List** and **Board**. On the board you drag a card to another column; the column lights up where you can drop it and turns red where you can't. On a phone, hold the card a moment before dragging.
- If someone else changed a task or the roadmap's settings while you had it open, saving tells you to reload instead of quietly overwriting their change.

### Right-click menu

Right-click a task, roadmap, person or comment for a menu with the things you're allowed to do there: open or edit, move to another status, assign, delete, settings, logs, archive, send a reset link, deactivate. On a touch screen, hold the item for about half a second. Text fields and selected text keep the browser's normal menu.

### Comments

Anyone on a roadmap can comment on its tasks. You can delete your own comments; the roadmap's owner can delete any comment on their roadmap, and IT any comment anywhere. The log records that a comment was deleted and whose it was, never what it said.

### Profiles

Everyone has a profile picture and a status (available, busy or away, plus a short message), shown as a dot on their picture throughout the app. Pictures are only shown to people who work with you: IT, your manager and people on the same roadmaps. Everyone else sees your initials.

### People leaving: deactivate, never delete

Accounts are never deleted, so the history stays complete.

- **Deactivate** signs the person out everywhere at once and stops them from signing in. They show as "Name (deactivated)" and their history stays. Their open tasks become unassigned and are flagged so the roadmap's owner picks someone new.
- Before IT can deactivate a manager who still owns roadmaps or team members, those are **transferred** to another manager, in one step.
- The last IT admin who can sign in can't be deactivated.
- **Reactivate** brings someone back. If IT deactivated them, only IT can.

### Archiving and deleting roadmaps

- **Archive** (the owner or IT) moves a finished roadmap into a collapsible **Archived** section. It stays readable but nothing in it can change, until someone unarchives it.
- **Delete** only hides a roadmap. IT still sees it, with its full log, under **Deleted roadmaps**.

### Logs

Everything that happens is logged: sign-ins and failed sign-ins, invites and resets, accounts, roadmaps, tasks, comments, profile changes, overrides, and anything the server refused. The log is append-only: nobody can edit or remove an entry, IT included, and the database itself enforces that.

- **Activity** (IT): the whole install.
- **Password log** (IT): which invite and reset links were issued, by whom, and when they were used. Passwords themselves are never shown or stored readably.
- **Logs** on a roadmap (IT and its owner): everything that happened on that roadmap.
- **Profile & log** on a person: their profile and what they did.

Every log can be searched and paged.

## Security in short

- The server enforces every rule above; the pages only hide buttons you can't use.
- Sessions live on the server and end at sign-out, deactivation or a password reset, and after 7 days at the latest.
- Passwords are stored only as bcrypt hashes and are never logged. Link tokens are stored only as hashes.
- Repeated failed sign-ins are slowed down and locked for 15 minutes, per account and address, without letting a stranger lock you out of your own account.
- A strict Content-Security-Policy, cross-site request checks and validated input throughout. Fonts are served by the app itself, so no visitor data goes to third parties.

## License

Source-available, **not** open source. You may read the code and contribute back through pull requests, but you may not redistribute, host or reuse it elsewhere. See [LICENSE](LICENSE).
