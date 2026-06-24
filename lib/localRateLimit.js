// Synchronous, in-memory, fixed-window rate limiter for high-frequency
// per-connection events (signal/chat). Deliberately NOT Redis-backed: these
// handlers sit in the WebRTC signaling hot path, and an awaited external call
// there reorders relayed messages (see SECURITY.md invariant #5 — we hit this
// directly, ICE candidates arrived before the offer/answer and were dropped).
function createLocalRateLimiter() {
  const store = new Map(); // key -> { count, resetAt }

  function check(key, max, windowMs) {
    const now = Date.now();
    const entry = store.get(key);
    if (!entry || now >= entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  }

  function clear(key) {
    store.delete(key);
  }

  function size() {
    return store.size;
  }

  return { check, clear, size };
}

module.exports = { createLocalRateLimiter };
