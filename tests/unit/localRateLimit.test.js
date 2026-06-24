const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalRateLimiter } = require('../../lib/localRateLimit');

test('allows calls under the limit', () => {
  const limiter = createLocalRateLimiter();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.check('k', 5, 1000), true);
  }
});

test('blocks calls once the limit is exceeded within the window', () => {
  const limiter = createLocalRateLimiter();
  for (let i = 0; i < 5; i += 1) {
    limiter.check('k', 5, 1000);
  }
  assert.equal(limiter.check('k', 5, 1000), false);
});

test('different keys have independent budgets', () => {
  const limiter = createLocalRateLimiter();
  for (let i = 0; i < 5; i += 1) {
    limiter.check('a', 5, 1000);
  }
  assert.equal(limiter.check('a', 5, 1000), false);
  assert.equal(limiter.check('b', 5, 1000), true);
});

test('resets the budget once the window elapses', async () => {
  const limiter = createLocalRateLimiter();
  for (let i = 0; i < 3; i += 1) {
    limiter.check('k', 3, 20);
  }
  assert.equal(limiter.check('k', 3, 20), false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(limiter.check('k', 3, 20), true);
});

test('clear() removes a key\'s state', () => {
  const limiter = createLocalRateLimiter();
  limiter.check('k', 1, 1000);
  assert.equal(limiter.check('k', 1, 1000), false);
  limiter.clear('k');
  assert.equal(limiter.check('k', 1, 1000), true);
});
