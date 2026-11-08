const path = require('path');
const express = require('express');
const { rootDir, TRUST_PROXY } = require('./config');

// Initialising db creates the SQLite file, tables and triggers on first run.
require('./db');

const securityHeaders = require('./middleware/security');
const csrf = require('./middleware/csrf');
const { loadUser } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const linkRoutes = require('./routes/links');
const userRoutes = require('./routes/users');
const meRoutes = require('./routes/me');
const roadmapRoutes = require('./routes/roadmaps');
const taskRoutes = require('./routes/tasks');
const adminRoutes = require('./routes/admin');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind cloudflared or another proxy, req.ip must be the visitor's address
  // or the per-IP sign-in limit would lock out everyone at once.
  app.set('trust proxy', TRUST_PROXY);

  app.use(securityHeaders);

  // --- API ---
  // Same-origin only: there is deliberately no CORS middleware.
  app.use('/api', express.json({ limit: '200kb' }));
  app.use('/api', csrf);
  app.use('/api', loadUser);
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/links', linkRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/admin', adminRoutes);
  // tasks router owns /roadmaps/:id/tasks, so it goes before the bare roadmaps router
  app.use('/api', taskRoutes);
  app.use('/api/roadmaps', roadmapRoutes);
  app.use('/api', meRoutes);

  // Unknown API route -> JSON 404 (never fall through to the static files).
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // --- Static frontend: only public/ is served, never server code or data ---
  const publicDir = path.join(rootDir, 'public');
  app.use(express.static(publicDir, { index: 'index.html', dotfiles: 'ignore', fallthrough: true }));
  app.use((req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });

  // JSON error handler. Never log the error object of a body-parser failure:
  // it carries the raw request body, which may hold a password.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request was not valid JSON.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
    if (err && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'That request could not be read.' });
    console.error('Request failed:', req.method, req.path, err && err.stack ? err.stack : String(err));
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return app;
}

module.exports = { createApp };
