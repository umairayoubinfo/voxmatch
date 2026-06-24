require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { createServer } = require('http');
const { Server } = require('socket.io');

const redis = require('./lib/redis');
const { ensureIdentity, identityFromSocket } = require('./lib/identity');
const { checkRateLimit } = require('./lib/rateLimit');
const { createLocalRateLimiter } = require('./lib/localRateLimit');
const { createAvoidPairs } = require('./lib/avoidPairs');
const { safeCompare } = require('./lib/auth');

const PORT = process.env.PORT || 3000;
const REPORT_BLOCK_THRESHOLD = 3;
const REPORT_TTL_SECONDS = 7 * 24 * 60 * 60;
const BAN_TTL_SECONDS = 24 * 60 * 60;
const REPORT_LOG_MAX = 500;
const FIND_PARTNER_LIMIT = { max: 20, windowSeconds: 60 };
const REPORT_LIMIT = { max: 5, windowSeconds: 10 * 60 };
const SIGNAL_LIMIT = { max: 300, windowSeconds: 60 };
const CHAT_LIMIT = { max: 30, windowSeconds: 30 };

const logger = pino();

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(pinoHttp({ logger }));
app.use(ensureIdentity);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address;
}

app.get('/ice-config', (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URLS) {
    iceServers.push({
      urls: process.env.TURN_URLS.split(',').map((s) => s.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.json({ iceServers });
});

app.get('/healthz', async (req, res) => {
  try {
    await redis.ping();
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'degraded' });
  }
});

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const secret = process.env.ADMIN_SECRET;
  if (!secret || !token || !safeCompare(token, secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/admin/reports', requireAdmin, async (req, res) => {
  const entries = await redis.lrange('reportlog', 0, REPORT_LOG_MAX - 1);
  res.json({ reports: entries.map((entry) => JSON.parse(entry)) });
});

app.post('/admin/unban/:id', requireAdmin, async (req, res) => {
  await redis.del(`ban:${req.params.id}`);
  await redis.del(`reports:${req.params.id}`);
  res.json({ ok: true });
});

const httpServer = createServer(app);
const io = new Server(httpServer);

// waiting queue of { socketId, identity }
const waitingQueue = [];
// socketId -> { identity, roomId, partnerSocketId }
const sessions = new Map();
// identity -> identities it has reported, expiring on the same schedule as
// the Redis report TTL (see lib/avoidPairs.js for why this isn't a plain Map)
const avoidPairs = createAvoidPairs(REPORT_TTL_SECONDS * 1000);
const avoidPairsSweep = setInterval(() => avoidPairs.sweep(), 60 * 60 * 1000);
avoidPairsSweep.unref();
// socketId -> rate-limit state for high-frequency events (signal/chat) — kept
// in-memory/synchronous on purpose, see lib/localRateLimit.js
const localLimiters = createLocalRateLimiter();

function removeFromQueue(socketId) {
  const idx = waitingQueue.findIndex((entry) => entry.socketId === socketId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function tryMatch(socket, identity) {
  const matchIndex = waitingQueue.findIndex((entry) => {
    if (entry.socketId === socket.id) return false;
    if (entry.identity === identity) return false;
    if (avoidPairs.shouldAvoid(entry.identity, identity)) return false;
    return true;
  });

  if (matchIndex === -1) {
    waitingQueue.push({ socketId: socket.id, identity });
    return;
  }

  const partner = waitingQueue.splice(matchIndex, 1)[0];
  const partnerSocket = io.sockets.sockets.get(partner.socketId);
  if (!partnerSocket) {
    tryMatch(socket, identity);
    return;
  }

  const roomId = `room-${socket.id}-${partner.socketId}`;
  socket.join(roomId);
  partnerSocket.join(roomId);

  sessions.set(socket.id, { identity, roomId, partnerSocketId: partner.socketId });
  sessions.set(partner.socketId, { identity: partner.identity, roomId, partnerSocketId: socket.id });

  logger.info({ roomId, socketIds: [socket.id, partner.socketId] }, 'matched');
  socket.emit('matched', { roomId, isOfferer: true });
  partnerSocket.emit('matched', { roomId, isOfferer: false });
}

function leaveRoom(socket, notifyPartner) {
  removeFromQueue(socket.id);
  const session = sessions.get(socket.id);
  if (!session) return;

  sessions.delete(socket.id);
  socket.leave(session.roomId);

  if (notifyPartner) {
    const partnerSocket = io.sockets.sockets.get(session.partnerSocketId);
    if (partnerSocket) {
      partnerSocket.emit('partner-left');
      partnerSocket.leave(session.roomId);
      sessions.delete(partnerSocket.id);
    }
  }
}

function broadcastOnlineCount() {
  io.emit('online-count', io.sockets.sockets.size);
}

io.on('connection', (socket) => {
  const identity = identityFromSocket(socket);
  if (!identity) {
    socket.disconnect(true);
    return;
  }
  socket.data.identity = identity;
  socket.data.ip = getClientIp(socket);

  const socketLog = logger.child({ identity, socketId: socket.id });
  socketLog.info('socket connected');

  broadcastOnlineCount();

  socket.on('find-partner', async () => {
    const allowed = await checkRateLimit(
      redis,
      `rl:find-partner:${identity}:${socket.data.ip}`,
      FIND_PARTNER_LIMIT.max,
      FIND_PARTNER_LIMIT.windowSeconds
    );
    if (!allowed) {
      socketLog.warn('find-partner rate-limited');
      socket.emit('rate-limited');
      return;
    }

    const banned = await redis.exists(`ban:${identity}`);
    if (banned) {
      socketLog.info('find-partner blocked (active ban)');
      socket.emit('blocked');
      return;
    }

    leaveRoom(socket, true);
    tryMatch(socket, identity);
  });

  socket.on('signal', (payload) => {
    const session = sessions.get(socket.id);
    if (!session) return;
    if (!localLimiters.check(`signal:${socket.id}`, SIGNAL_LIMIT.max, SIGNAL_LIMIT.windowSeconds * 1000)) {
      return;
    }
    const partnerSocket = io.sockets.sockets.get(session.partnerSocketId);
    if (partnerSocket) partnerSocket.emit('signal', payload);
  });

  socket.on('chat-message', ({ text } = {}) => {
    const session = sessions.get(socket.id);
    if (!session || typeof text !== 'string' || !text.trim()) return;
    if (!localLimiters.check(`chat:${socket.id}`, CHAT_LIMIT.max, CHAT_LIMIT.windowSeconds * 1000)) {
      socket.emit('rate-limited');
      return;
    }
    const partnerSocket = io.sockets.sockets.get(session.partnerSocketId);
    if (partnerSocket) partnerSocket.emit('chat-message', { text: text.slice(0, 1000) });
  });

  socket.on('report', async () => {
    const allowed = await checkRateLimit(
      redis,
      `rl:report:${identity}`,
      REPORT_LIMIT.max,
      REPORT_LIMIT.windowSeconds
    );
    if (!allowed) {
      socketLog.warn('report rate-limited');
      socket.emit('rate-limited');
      return;
    }

    const session = sessions.get(socket.id);
    const partnerSocket = session ? io.sockets.sockets.get(session.partnerSocketId) : null;
    const reportedIdentity = partnerSocket?.data.identity;

    if (reportedIdentity) {
      const reportKey = `reports:${reportedIdentity}`;
      const count = await redis.incr(reportKey);
      await redis.expire(reportKey, REPORT_TTL_SECONDS);
      await redis.lpush(
        'reportlog',
        JSON.stringify({ time: Date.now(), reporterId: identity, reportedId: reportedIdentity })
      );
      await redis.ltrim('reportlog', 0, REPORT_LOG_MAX - 1);

      socketLog.info({ reportedIdentity, count }, 'report filed');

      if (count >= REPORT_BLOCK_THRESHOLD) {
        await redis.set(`ban:${reportedIdentity}`, '1', 'EX', BAN_TTL_SECONDS);
        logger.warn({ reportedIdentity, count }, 'identity banned');
      }

      avoidPairs.add(identity, reportedIdentity);
    }

    leaveRoom(socket, true);
  });

  socket.on('skip', () => {
    socketLog.info('skip');
    leaveRoom(socket, true);
    tryMatch(socket, identity);
  });

  socket.on('stop', () => {
    socketLog.info('stop');
    leaveRoom(socket, true);
  });

  socket.on('disconnect', (reason) => {
    socketLog.info({ reason }, 'socket disconnected');
    leaveRoom(socket, true);
    localLimiters.clear(`signal:${socket.id}`);
    localLimiters.clear(`chat:${socket.id}`);
    broadcastOnlineCount();
  });
});

const server = httpServer.listen(PORT, () => {
  logger.info(`VoxMatch server listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  server.close(() => {
    redis.disconnect();
    process.exit(0);
  });
});

module.exports = { app, httpServer };
