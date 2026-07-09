const session = require('express-session');
const bcrypt  = require('bcryptjs');
const {
  db, getUserById, getUserByEmail, insertUser, setUserPassword,
  seedDefaultsForUser, setOnboardingDone,
} = require('./db');

// ── session store ─────────────────────────────────────────────────────────────
// Custom minimal express-session Store backed by better-sqlite3 (the `sessions`
// table lives in db.js's schema, alongside everything else). Deliberately not
// using connect-sqlite3 — that package pulls in the legacy `sqlite3` npm
// package (a second, different SQLite driver from better-sqlite3, which is
// already the sole DB driver everywhere else in this app) plus a chain of
// deprecated transitive deps with real CVEs (critical form-data/request
// vulnerabilities). This is ~30 lines and avoids both problems.

const getSessionStmt = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
const setSessionStmt = db.prepare(`
  INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
  ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
`);
const destroySessionStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
const pruneExpiredStmt   = db.prepare('DELETE FROM sessions WHERE expires < ?');

function sessionExpiryMs(sess) {
  return sess.cookie && sess.cookie.expires
    ? new Date(sess.cookie.expires).getTime()
    : Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days default
}

class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    // Sweep expired sessions hourly instead of on every read — cheap and
    // keeps the sessions table from growing unbounded.
    setInterval(() => {
      try { pruneExpiredStmt.run(Date.now()); } catch (err) { console.error('[auth] session prune failed:', err.message); }
    }, 60 * 60 * 1000).unref();
  }

  get(sid, cb) {
    try {
      const row = getSessionStmt.get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) { destroySessionStmt.run(sid); return cb(null, null); }
      cb(null, JSON.parse(row.sess));
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try {
      setSessionStmt.run(sid, JSON.stringify(sess), sessionExpiryMs(sess));
      cb && cb(null);
    } catch (err) { cb && cb(err); }
  }

  destroy(sid, cb) {
    try { destroySessionStmt.run(sid); cb && cb(null); } catch (err) { cb && cb(err); }
  }

  touch(sid, sess, cb) {
    try {
      setSessionStmt.run(sid, JSON.stringify(sess), sessionExpiryMs(sess));
      cb && cb(null);
    } catch (err) { cb && cb(err); }
  }
}

if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET not set — using an insecure generated fallback. Set SESSION_SECRET in production.');
}

const sessionMiddleware = session({
  store:  new SqliteSessionStore(),
  secret: process.env.SESSION_SECRET || 'lifeline-dev-insecure-secret-set-SESSION_SECRET-env-var',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
  },
});

// ── password helpers ─────────────────────────────────────────────────────────

const BCRYPT_ROUNDS = 12;

function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id:                   user.id,
    email:                user.email,
    name:                 user.name,
    onboarding_completed: !!user.onboarding_completed,
    telegram_connected:   !!user.telegram_chat_id,
  };
}

// ── middleware ────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = getUserById.get(userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.user = user;
  next();
}

// ── routes ────────────────────────────────────────────────────────────────────
// Registered directly on the app by server.js (not an isolated Router) so
// they can sit alongside the requireAuth exemption list in one obvious place.

function registerAuthRoutes(app) {
  app.post('/api/auth/signup', (req, res) => {
    const { email, password, name } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    if (getUserByEmail.get(normalizedEmail)) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const info = insertUser.run(normalizedEmail, hashPassword(password), name || null, 0);
    const user = getUserById.get(info.lastInsertRowid);
    seedDefaultsForUser(user.id); // no-op for anyone but user 1 — kept for consistency

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Signup succeeded but session setup failed — try logging in' });
      req.session.userId = user.id;
      res.status(201).json(publicUser(user));
    });
  });

  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    const user = getUserByEmail.get(String(email).trim().toLowerCase());
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Bootstrap path: the migrated OGV account (and only that account — no
    // other code path ever creates a user with a NULL password_hash) has no
    // password yet. Whoever first logs in with the correct email sets it.
    // This is a real exposure window between deploy and OGV actually logging
    // in; acceptable per the discussed tradeoff (tiny user base, no email
    // infra to do this more safely via a claim link) but worth him doing
    // promptly after this ships.
    if (user.password_hash === null) {
      setUserPassword.run(hashPassword(password), user.id);
      console.warn(`[auth] bootstrap password set for ${user.email} (user ${user.id})`);
    } else if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Login failed — try again' });
      req.session.userId = user.id;
      res.json(publicUser(user));
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.status(204).end();
    });
  });

  app.get('/api/auth/me', (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const user = getUserById.get(userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    res.json(publicUser(user));
  });

  // Onboarding wizard's "Finish" step. Only supports flipping
  // onboarding_completed — nothing else about the account is editable here.
  app.patch('/api/auth/me', (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const user = getUserById.get(userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.body && req.body.onboarding_completed === true) {
      setOnboardingDone.run(userId);
    }
    res.json(publicUser(getUserById.get(userId)));
  });
}

module.exports = {
  sessionMiddleware,
  requireAuth,
  registerAuthRoutes,
  hashPassword,
  verifyPassword,
  publicUser,
};
