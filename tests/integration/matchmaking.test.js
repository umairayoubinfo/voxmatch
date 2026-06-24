const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../helpers/testServer');
const {
  getFreshCookie,
  connectClient,
  waitForEvent,
  assertEventDoesNotFire,
} = require('../helpers/socketClient');

const PORT = 3501;
let server;

before(async () => {
  server = await startTestServer(PORT);
});

after(async () => {
  await server.stop();
});

async function newClient(cookie) {
  const cookieToUse = cookie || (await getFreshCookie(server.baseUrl));
  const socket = connectClient(server.baseUrl, cookieToUse);
  await waitForEvent(socket, 'connect');
  return socket;
}

// Each test disconnects every socket it created before returning, so the
// server's waiting queue is always empty at the start of the next test —
// a socket left queued-but-unmatched would otherwise silently steal the
// next test's intended match.
function disconnectAll(...socketsToClose) {
  socketsToClose.forEach((s) => s.disconnect());
}

test('two different identities get matched, with exactly one offerer', async () => {
  const a = await newClient();
  const b = await newClient();
  try {
    a.emit('find-partner');
    b.emit('find-partner');

    const [matchedA, matchedB] = await Promise.all([
      waitForEvent(a, 'matched'),
      waitForEvent(b, 'matched'),
    ]);

    assert.notEqual(matchedA.isOfferer, matchedB.isOfferer, 'exactly one side should be the offerer');
  } finally {
    disconnectAll(a, b);
  }
});

test('two sockets sharing the same identity (cookie) never match each other', async () => {
  const sharedCookie = await getFreshCookie(server.baseUrl);
  const a = await newClient(sharedCookie);
  const b = await newClient(sharedCookie);
  let c;
  try {
    a.emit('find-partner');
    b.emit('find-partner');

    // Neither should match the other — they're the same identity.
    await Promise.all([
      assertEventDoesNotFire(a, 'matched', 800),
      assertEventDoesNotFire(b, 'matched', 800),
    ]);

    // A third, genuinely different identity should still be able to match
    // one of them — proves the queue isn't stuck, only self-matching is blocked.
    c = await newClient();
    c.emit('find-partner');

    const [, matchedSide] = await Promise.race([
      waitForEvent(a, 'matched').then((m) => ['a', m]),
      waitForEvent(b, 'matched').then((m) => ['b', m]),
    ]);
    assert.ok(matchedSide, 'a different identity should be able to match one of the queued sockets');
  } finally {
    disconnectAll(a, b, ...(c ? [c] : []));
  }
});

test('signal payloads are relayed verbatim to the matched partner', async () => {
  const a = await newClient();
  const b = await newClient();
  try {
    a.emit('find-partner');
    b.emit('find-partner');
    await Promise.all([waitForEvent(a, 'matched'), waitForEvent(b, 'matched')]);

    const payload = { type: 'offer', sdp: { type: 'offer', sdp: 'v=0 fake-sdp-for-test' } };
    a.emit('signal', payload);

    const received = await waitForEvent(b, 'signal');
    assert.deepEqual(received, payload);
  } finally {
    disconnectAll(a, b);
  }
});

test('skip ends the current match and re-queues for a new partner', async () => {
  const a = await newClient();
  const b = await newClient();
  let c;
  try {
    a.emit('find-partner');
    b.emit('find-partner');
    await Promise.all([waitForEvent(a, 'matched'), waitForEvent(b, 'matched')]);

    a.emit('skip');
    await waitForEvent(b, 'partner-left');

    c = await newClient();
    c.emit('find-partner');
    const matchedC = await waitForEvent(c, 'matched');
    assert.ok(matchedC, 'the skipping socket should be back in the queue and matchable');
  } finally {
    disconnectAll(a, b, ...(c ? [c] : []));
  }
});
