const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../helpers/testServer');
const { getFreshCookie, connectClient, waitForEvent } = require('../helpers/socketClient');

const PORT = 3502;
let server;

before(async () => {
  server = await startTestServer(PORT);
});

after(async () => {
  await server.stop();
});

async function newClient() {
  const cookie = await getFreshCookie(server.baseUrl);
  const socket = connectClient(server.baseUrl, cookie);
  await waitForEvent(socket, 'connect');
  return socket;
}

async function matchAndReport(victim, reporter) {
  victim.emit('find-partner');
  reporter.emit('find-partner');
  await Promise.all([waitForEvent(victim, 'matched'), waitForEvent(reporter, 'matched')]);
  reporter.emit('report');
  // 'report' tears down the room on both sides; wait for the victim's side
  // to settle before the next reporter tries to match with them.
  await waitForEvent(victim, 'partner-left');
}

test('3 distinct reports against the same identity within the window trigger a ban', async () => {
  const victim = await newClient();
  const reporter1 = await newClient();
  const reporter2 = await newClient();
  const reporter3 = await newClient();

  try {
    // A single reporter can't reach the threshold alone: after reporting once,
    // avoidPairs stops them ever being matched with the victim again. The
    // threshold models 3 *different* people reporting the same identity.
    await matchAndReport(victim, reporter1);
    await matchAndReport(victim, reporter2);
    await matchAndReport(victim, reporter3);

    victim.emit('find-partner');
    await waitForEvent(victim, 'blocked');
  } finally {
    [victim, reporter1, reporter2, reporter3].forEach((s) => s.disconnect());
  }
});

test('a previously-reported pair is never matched again', async () => {
  const victim = await newClient();
  const reporter = await newClient();
  let stranger;

  try {
    await matchAndReport(victim, reporter);

    // Both go back into the queue; they must not be re-paired with each other.
    victim.emit('find-partner');
    reporter.emit('find-partner');

    stranger = await newClient();
    stranger.emit('find-partner');

    // The stranger should be able to match one of them...
    const matched = await waitForEvent(stranger, 'matched');
    assert.ok(matched);
  } finally {
    [victim, reporter, ...(stranger ? [stranger] : [])].forEach((s) => s.disconnect());
  }
});
