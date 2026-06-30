#!/usr/bin/env node
// Standalone matchmaking/signaling load test — NOT part of `npm test`.
// Simulates N concurrent users hitting find-partner/skip/signal/chat-message
// against a real running server (local or deployed), then prints latency
// and error stats.
//
// What this DOES exercise: matchmaking queue, Socket.IO connection handling,
// the online-count broadcast throttle, Redis-backed rate limits, signal/chat
// relay.
//
// What this does NOT exercise: real WebRTC audio/TURN relay. Audio never
// passes through this server (peer-to-peer or via TURN), so this script
// can't tell you whether your TURN provider holds up under load — only
// whether the signaling server and matchmaking logic do.
//
// Usage:
//   node scripts/loadtest.js --url=http://localhost:3000 --clients=1000
//
// Flags (all optional):
//   --url        target server base URL        (default: http://localhost:3000)
//   --clients    number of concurrent simulated users  (default: 1000)
//   --rampMs     spread connections over this many ms, instead of all at once (default: 20000)
//   --durationMs total test duration before everyone disconnects (default: 60000)
//   --holdMinMs  min time a matched pair "stays in call" before skip (default: 4000)
//   --holdMaxMs  max time a matched pair "stays in call" before skip (default: 15000)
//
// Caution: running this against a real deployed URL generates real traffic
// against your real Redis and real server instance. Don't point it at
// production while real users are on it unless that's the point of the test.

const { io } = require('socket.io-client');

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) args[match[1]] = match[2];
  }
  return {
    url: args.url || process.env.VOXMATCH_URL || 'http://localhost:3000',
    clients: Number(args.clients || 1000),
    rampMs: Number(args.rampMs || 20000),
    durationMs: Number(args.durationMs || 60000),
    holdMinMs: Number(args.holdMinMs || 4000),
    holdMaxMs: Number(args.holdMaxMs || 15000),
  };
}

const config = parseArgs();

const stats = {
  connectAttempts: 0,
  connectSuccesses: 0,
  connectErrors: 0,
  matched: 0,
  skipped: 0,
  stopped: 0,
  rateLimited: 0,
  blocked: 0,
  signalsSent: 0,
  chatsSent: 0,
  disconnects: 0,
  matchLatenciesMs: [],
  peakOnlineCount: 0,
  errors: [],
};

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

async function getFreshCookie(baseUrl) {
  const res = await fetch(`${baseUrl}/healthz`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('no Set-Cookie header in /healthz response');
  return setCookie.split(';')[0];
}

function runClient(clientIndex, testDeadline) {
  return new Promise((resolve) => {
    let socket;
    let findPartnerSentAt = null;
    let holdTimer = null;
    let stopped = false;

    function cleanup() {
      stopped = true;
      if (holdTimer) clearTimeout(holdTimer);
      if (socket) socket.disconnect();
      resolve();
    }

    // Each simulated user keeps queuing/matching/skipping until the test
    // deadline, the same way a real visitor would click Start, talk for a
    // while, then Skip, repeatedly.
    function findPartner() {
      if (stopped || Date.now() >= testDeadline) {
        if (socket) socket.emit('stop');
        cleanup();
        return;
      }
      findPartnerSentAt = Date.now();
      socket.emit('find-partner');
    }

    function onMatched() {
      stats.matched += 1;
      if (findPartnerSentAt) {
        stats.matchLatenciesMs.push(Date.now() - findPartnerSentAt);
      }

      // Simulate light signaling/chat traffic while "in a call", like real
      // ICE candidate trickle and the occasional chat message.
      const signalInterval = setInterval(() => {
        if (stopped) return clearInterval(signalInterval);
        socket.emit('signal', { type: 'candidate', candidate: `fake-candidate-${Math.random()}` });
        stats.signalsSent += 1;
      }, 2000);

      if (Math.random() < 0.3) {
        setTimeout(() => {
          if (stopped) return;
          socket.emit('chat-message', { text: 'hey' });
          stats.chatsSent += 1;
        }, randomBetween(500, 3000));
      }

      const holdMs = randomBetween(config.holdMinMs, config.holdMaxMs);
      holdTimer = setTimeout(() => {
        clearInterval(signalInterval);
        if (stopped) return;
        if (Date.now() >= testDeadline) {
          socket.emit('stop');
          stats.stopped += 1;
          cleanup();
        } else {
          socket.emit('skip');
          stats.skipped += 1;
          findPartner();
        }
      }, holdMs);
    }

    (async () => {
      try {
        stats.connectAttempts += 1;
        const cookie = await getFreshCookie(config.url);
        socket = io(config.url, {
          extraHeaders: { Cookie: cookie },
          transports: ['websocket'],
          forceNew: true,
          reconnection: false,
          timeout: 10000,
        });

        socket.on('connect', () => {
          stats.connectSuccesses += 1;
          findPartner();
        });

        socket.on('matched', onMatched);

        socket.on('partner-left', () => {
          if (!stopped) findPartner();
        });

        socket.on('rate-limited', () => {
          stats.rateLimited += 1;
        });

        socket.on('blocked', () => {
          stats.blocked += 1;
          cleanup();
        });

        socket.on('online-count', (count) => {
          if (count > stats.peakOnlineCount) stats.peakOnlineCount = count;
        });

        socket.on('connect_error', (err) => {
          stats.connectErrors += 1;
          stats.errors.push(`client ${clientIndex} connect_error: ${err.message}`);
          cleanup();
        });

        socket.on('disconnect', () => {
          stats.disconnects += 1;
          if (!stopped) cleanup();
        });
      } catch (err) {
        stats.connectErrors += 1;
        stats.errors.push(`client ${clientIndex} setup failed: ${err.message}`);
        cleanup();
      }
    })();
  });
}

async function main() {
  console.log(`VoxMatch load test
  target:      ${config.url}
  clients:     ${config.clients}
  ramp-up:     ${config.rampMs}ms
  duration:    ${config.durationMs}ms
  hold time:   ${config.holdMinMs}-${config.holdMaxMs}ms per match
`);

  const startedAt = Date.now();
  const testDeadline = startedAt + config.durationMs;
  const clientPromises = [];

  for (let i = 0; i < config.clients; i += 1) {
    const delay = (config.rampMs * i) / config.clients;
    clientPromises.push(
      new Promise((resolve) => setTimeout(resolve, delay)).then(() => runClient(i, testDeadline))
    );
  }

  const progressTimer = setInterval(() => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(
      `[${elapsed}s] connected=${stats.connectSuccesses} matched=${stats.matched} ` +
        `rateLimited=${stats.rateLimited} errors=${stats.connectErrors} peakOnline=${stats.peakOnlineCount}`
    );
  }, 5000);
  progressTimer.unref();

  await Promise.all(clientPromises);
  clearInterval(progressTimer);

  const sorted = [...stats.matchLatenciesMs].sort((a, b) => a - b);
  const totalMs = Date.now() - startedAt;

  console.log(`\n--- Results (${(totalMs / 1000).toFixed(1)}s total) ---`);
  console.log(`connect attempts:   ${stats.connectAttempts}`);
  console.log(`connect successes:  ${stats.connectSuccesses}`);
  console.log(`connect errors:     ${stats.connectErrors}`);
  console.log(`peak online-count:  ${stats.peakOnlineCount}`);
  console.log(`matches:            ${stats.matched}`);
  console.log(`skips:              ${stats.skipped}`);
  console.log(`stops:              ${stats.stopped}`);
  console.log(`rate-limited hits:  ${stats.rateLimited}`);
  console.log(`blocked (banned):   ${stats.blocked}`);
  console.log(`signals sent:       ${stats.signalsSent}`);
  console.log(`chats sent:         ${stats.chatsSent}`);
  console.log(`\nmatch latency (find-partner -> matched), ms:`);
  console.log(`  min: ${sorted[0] ?? 'n/a'}`);
  console.log(`  p50: ${percentile(sorted, 50) ?? 'n/a'}`);
  console.log(`  p95: ${percentile(sorted, 95) ?? 'n/a'}`);
  console.log(`  p99: ${percentile(sorted, 99) ?? 'n/a'}`);
  console.log(`  max: ${sorted[sorted.length - 1] ?? 'n/a'}`);

  if (stats.errors.length > 0) {
    console.log(`\nfirst ${Math.min(20, stats.errors.length)} errors:`);
    stats.errors.slice(0, 20).forEach((e) => console.log(`  ${e}`));
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('load test crashed:', err);
  process.exit(1);
});
