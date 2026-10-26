// services/auth.js - single-user login with signed, stateless session cookies.
// Stateless on purpose: Vercel functions don't share memory, so the session lives in the cookie itself
// (HMAC-signed, so it can't be forged or edited) instead of in a server-side session store.
const crypto = require('crypto');
const { promisify } = require('util');
const db = require('./db');

const scrypt = promisify(crypto.scrypt);

const COOKIE_NAME = 'bluebee_session';
const MAX_FAILS = 5;            // failed sign-ins allowed per IP...
const LOCKOUT_WINDOW_SEC = 900; // ...within this window (15 minutes)

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Read lazily so env changes (and tests) are always honoured.
function getConfig() {
  return {
    email: (process.env.AUTH_EMAIL || '').trim().toLowerCase(),
    passwordHash: (process.env.AUTH_PASSWORD_HASH || '').trim(),
    passwordPlain: process.env.AUTH_PASSWORD || '',
    secret: process.env.AUTH_SECRET || '',
    idleMs: num(process.env.SESSION_IDLE_MINUTES, 30) * 60000,   // log out after this much inactivity
    maxMs: num(process.env.SESSION_MAX_HOURS, 12) * 3600000      // log out after this long no matter what
  };
}

function isConfigured() {
  const c = getConfig();
  return !!(c.email && (c.passwordHash || c.passwordPlain) && c.secret.length >= 32);
}

/* ---------- passwords ---------- */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

// Format: scrypt:N:r:p:<salt>:<hash>   (base64url, so it is safe in .env files and shells)
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

async function verifyHash(password, stored) {
  const parts = String(stored).split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(hashB64, 'base64url');
  if (!salt.length || !expected.length) return false;
  const key = await scrypt(password, salt, expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

let warnedPlain = false;
async function verifyLogin(email, password) {
  const c = getConfig();
  if (typeof email !== 'string' || typeof password !== 'string') return false;
  if (email.length > 320 || password.length > 1024) return false;

  // The password check always runs, even for a wrong email, so timing doesn't reveal which was wrong.
  const emailOk = safeEqual(email.trim().toLowerCase(), c.email);
  let passwordOk = false;
  if (c.passwordHash) {
    passwordOk = await verifyHash(password, c.passwordHash).catch(() => false);
  } else if (c.passwordPlain) {
    if (!warnedPlain) {
      warnedPlain = true;
      console.warn('[Auth] AUTH_PASSWORD is stored in plain text. Prefer AUTH_PASSWORD_HASH (npm run hash-password).');
    }
    passwordOk = safeEqual(password, c.passwordPlain);
  }
  return emailOk && passwordOk;
}

/* ---------- session tokens ---------- */

const sign = (data) => crypto.createHmac('sha256', getConfig().secret).update(data).digest('base64url');

function issueToken(user, { iat, la } = {}) {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ u: user, iat: iat || now, la: la || now })).toString('base64url');
  return `v1.${payload}.${sign(`v1.${payload}`)}`;
}

function parseToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const expected = Buffer.from(sign(`v1.${parts[1]}`));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return data && typeof data.u === 'string' && Number.isFinite(data.iat) && Number.isFinite(data.la) ? data : null;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
  return out;
}

/** { ok, user, data, reason } where reason is none | unconfigured | invalid | expired */
function readSession(req) {
  const token = parseCookies(req.headers && req.headers.cookie)[COOKIE_NAME];
  if (!token) return { ok: false, reason: 'none' };
  if (!isConfigured()) return { ok: false, reason: 'unconfigured' };
  const data = parseToken(token);
  const c = getConfig();
  if (!data || data.u !== c.email) return { ok: false, reason: 'invalid' };
  const now = Date.now();
  if (now - data.iat > c.maxMs || now - data.la > c.idleMs) return { ok: false, reason: 'expired' };
  return { ok: true, user: data.u, data };
}

const isSecure = (req) =>
  String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim() === 'https' || req.secure === true;

function writeCookie(req, res, value, maxAgeSec) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}${isSecure(req) ? '; Secure' : ''}`
  );
}

function setSessionCookie(req, res, token, iat = Date.now()) {
  const c = getConfig();
  // The cookie itself also dies at the idle/absolute limit, which is what lets Vercel's "no cookie -> login"
  // redirect work without ever running our code.
  writeCookie(req, res, token, Math.min(c.idleMs, c.maxMs - (Date.now() - iat)) / 1000);
}

const clearSessionCookie = (req, res) => writeCookie(req, res, '', 0);

/* ---------- middleware ---------- */

function requireAuth(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isConfigured()) {
    return res.status(503).json({
      error: 'Login is not set up on the server yet. Add AUTH_EMAIL, AUTH_PASSWORD_HASH and AUTH_SECRET to the environment variables.',
      code: 'unconfigured'
    });
  }
  const s = readSession(req);
  if (!s.ok) {
    if (s.reason === 'expired' || s.reason === 'invalid') clearSessionCookie(req, res);
    const expired = s.reason === 'expired';
    return res.status(401).json({
      error: expired ? 'Your session expired. Please sign in again.' : 'Please sign in to continue.',
      code: expired ? 'expired' : 'unauthenticated'
    });
  }

  const c = getConfig();
  const now = Date.now();
  let la = s.data.la;
  // Sliding idle timeout: any authenticated request pushes the idle deadline out (re-issued at most
  // every few seconds so we don't rewrite the cookie on every single call).
  if (now - la > Math.min(30000, c.idleMs / 4)) {
    la = now;
    setSessionCookie(req, res, issueToken(s.user, { iat: s.data.iat, la }), s.data.iat);
  }
  res.setHeader('X-Session-Remaining-Ms', String(Math.max(0, Math.min(c.idleMs - (now - la), c.maxMs - (now - s.data.iat)))));
  req.user = s.user;
  return next();
}

// Blocks cross-site form posts / fetches that try to ride on the session cookie.
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers && req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch { ok = false; }
    if (!ok) return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  return next();
}

/* ---------- brute-force protection (per IP) ---------- */

const clientIp = (req) =>
  String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim() ||
  (req.headers && req.headers['x-real-ip']) ||
  (req.socket && req.socket.remoteAddress) ||
  'unknown';

const failKey = (ip) => `bluebee_login_fail:${ip}`;

async function isLockedOut(ip) {
  try { return (await db.getCounter(failKey(ip))) >= MAX_FAILS; } catch { return false; }
}
async function recordFailure(ip) {
  try { await db.bumpCounter(failKey(ip), LOCKOUT_WINDOW_SEC); } catch { /* never block sign-in on a counter error */ }
}
async function clearFailures(ip) {
  try { await db.resetCounter(failKey(ip)); } catch { /* ignore */ }
}

module.exports = {
  COOKIE_NAME, MAX_FAILS, LOCKOUT_WINDOW_SEC,
  getConfig, isConfigured,
  hashPassword, verifyHash, verifyLogin,
  issueToken, parseToken, readSession, setSessionCookie, clearSessionCookie,
  requireAuth, sameOrigin,
  clientIp, isLockedOut, recordFailure, clearFailures
};
