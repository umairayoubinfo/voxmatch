const crypto = require('crypto');
const cookie = require('cookie');

const COOKIE_NAME = 'vm_id';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

if (!process.env.COOKIE_SECRET) {
  throw new Error('COOKIE_SECRET environment variable is required');
}

function sign(uuid) {
  return crypto.createHmac('sha256', process.env.COOKIE_SECRET).update(uuid).digest('hex');
}

function pack(uuid) {
  return `${uuid}.${sign(uuid)}`;
}

function unpack(value) {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot === -1) return null;
  const uuid = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expected = sign(uuid);
  const sigBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  return uuid;
}

function readFromCookieHeader(cookieHeader) {
  if (!cookieHeader) return null;
  const parsed = cookie.parse(cookieHeader);
  return unpack(parsed[COOKIE_NAME]);
}

// Express middleware: ensures every request has a valid signed identity cookie,
// issuing one if absent/invalid. Sets req.identity to the verified uuid.
function ensureIdentity(req, res, next) {
  const existing = readFromCookieHeader(req.headers.cookie);
  if (existing) {
    req.identity = existing;
    return next();
  }

  const uuid = crypto.randomUUID();
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(COOKIE_NAME, pack(uuid), {
      httpOnly: true,
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      sameSite: 'lax',
      maxAge: MAX_AGE_SECONDS,
      path: '/',
    })
  );
  req.identity = uuid;
  next();
}

// For Socket.IO connections: reads the identity cookie set during the page's
// initial HTTP load. Returns null if missing/invalid (the page load should have
// already set it, so this should only be null for non-browser/forged clients).
function identityFromSocket(socket) {
  return readFromCookieHeader(socket.handshake.headers.cookie);
}

module.exports = { ensureIdentity, identityFromSocket, COOKIE_NAME };
