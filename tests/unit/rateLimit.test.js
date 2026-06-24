const test = require('node:test');
const assert = require('node:assert/strict');
const { checkRateLimit } = require('../../lib/rateLimit');

// Minimal in-memory double for the two ioredis calls checkRateLimit uses,
// so this test doesn't need a live Redis connection.
function fakeRedis() {
  const counts = new Map();
  return {
    async incr(key) {
      const next = (counts.get(key) || 0) + 1;
      counts.set(key, next);
      return next;
    },
    async expire() {
      return 1;
    },
  };
}

test('allows calls under the limit', async () => {
  const redis = fakeRedis();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await checkRateLimit(redis, 'k', 3, 60), true);
  }
});

test('blocks calls once the limit is exceeded', async () => {
  const redis = fakeRedis();
  for (let i = 0; i < 3; i += 1) {
    await checkRateLimit(redis, 'k', 3, 60);
  }
  assert.equal(await checkRateLimit(redis, 'k', 3, 60), false);
});

test('different keys have independent budgets', async () => {
  const redis = fakeRedis();
  for (let i = 0; i < 3; i += 1) {
    await checkRateLimit(redis, 'a', 3, 60);
  }
  assert.equal(await checkRateLimit(redis, 'a', 3, 60), false);
  assert.equal(await checkRateLimit(redis, 'b', 3, 60), true);
});

test('sets an expiry only on the first increment', async () => {
  const redis = fakeRedis();
  let expireCalls = 0;
  redis.expire = async () => {
    expireCalls += 1;
    return 1;
  };
  await checkRateLimit(redis, 'k', 5, 60);
  await checkRateLimit(redis, 'k', 5, 60);
  await checkRateLimit(redis, 'k', 5, 60);
  assert.equal(expireCalls, 1);
});
