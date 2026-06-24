const { io } = require('socket.io-client');

// The identity cookie is issued by Express middleware on any HTTP request,
// not by the socket handshake itself — so tests fetch a real HTTP response
// first to get a cookie, exactly like a browser loading the page would.
async function getFreshCookie(baseUrl) {
  const res = await fetch(`${baseUrl}/healthz`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('Expected a Set-Cookie header for a fresh client');
  return setCookie.split(';')[0]; // "vm_id=<value>"
}

function connectClient(baseUrl, cookie) {
  return io(baseUrl, {
    extraHeaders: { Cookie: cookie },
    transports: ['websocket'],
    forceNew: true,
  });
}

function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    socket.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args.length <= 1 ? args[0] : args);
    });
  });
}

// Resolves with a sentinel if the event does NOT fire within timeoutMs —
// used to assert something deliberately did not happen (e.g. self-match).
function assertEventDoesNotFire(socket, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, timeoutMs);
    function onEvent() {
      clearTimeout(timer);
      reject(new Error(`Expected "${event}" not to fire, but it did`));
    }
    socket.once(event, onEvent);
  });
}

module.exports = { getFreshCookie, connectClient, waitForEvent, assertEventDoesNotFire };
