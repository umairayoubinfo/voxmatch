const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../helpers/testServer');
const { getFreshCookie, connectClient, waitForEvent } = require('../helpers/socketClient');

const PORT = 3504;
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

test('chat-message is rate-limited per connection, partner only gets messages within budget', async () => {
  // CHAT_LIMIT in server.js is { max: 30, windowSeconds: 30 }.
  const a = await newClient();
  const b = await newClient();
  try {
    a.emit('find-partner');
    b.emit('find-partner');
    await Promise.all([waitForEvent(a, 'matched'), waitForEvent(b, 'matched')]);

    let receivedByB = 0;
    b.on('chat-message', () => {
      receivedByB += 1;
    });

    const rateLimitedPromise = waitForEvent(a, 'rate-limited', 5000);

    for (let i = 0; i < 35; i += 1) {
      a.emit('chat-message', { text: `message ${i}` });
    }

    await rateLimitedPromise;
    await new Promise((resolve) => setTimeout(resolve, 300)); // let any in-flight relays land

    assert.ok(receivedByB <= 30, `partner should receive at most 30 messages, got ${receivedByB}`);
    assert.ok(receivedByB >= 25, `expected most of the budget to land, got ${receivedByB}`);
  } finally {
    a.disconnect();
    b.disconnect();
  }
});

test('chat-message rate limit is independent per connection', async () => {
  const a = await newClient();
  const b = await newClient();
  try {
    a.emit('find-partner');
    b.emit('find-partner');
    await Promise.all([waitForEvent(a, 'matched'), waitForEvent(b, 'matched')]);

    for (let i = 0; i < 35; i += 1) {
      a.emit('chat-message', { text: `flood ${i}` });
    }
    await waitForEvent(a, 'rate-limited', 5000);

    // b never sent anything, so b should not be rate-limited.
    let bWasRateLimited = false;
    b.once('rate-limited', () => {
      bWasRateLimited = true;
    });
    b.emit('chat-message', { text: 'hello from b' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(bWasRateLimited, false);
  } finally {
    a.disconnect();
    b.disconnect();
  }
});
