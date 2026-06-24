const test = require('node:test');
const assert = require('node:assert/strict');
const { createAvoidPairs } = require('../../lib/avoidPairs');

test('shouldAvoid is false for an unrelated pair', () => {
  const pairs = createAvoidPairs(60_000);
  assert.equal(pairs.shouldAvoid('alice', 'bob'), false);
});

test('shouldAvoid is true right after a report, in both directions', () => {
  const pairs = createAvoidPairs(60_000);
  pairs.add('alice', 'bob');
  assert.equal(pairs.shouldAvoid('alice', 'bob'), true);
  assert.equal(pairs.shouldAvoid('bob', 'alice'), true);
});

test('entries expire after their TTL', async () => {
  const pairs = createAvoidPairs(20);
  pairs.add('alice', 'bob');
  assert.equal(pairs.shouldAvoid('alice', 'bob'), true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(pairs.shouldAvoid('alice', 'bob'), false);
});

test('an expired lookup frees the memory for that pair', async () => {
  const pairs = createAvoidPairs(20);
  pairs.add('alice', 'bob');
  assert.equal(pairs.size(), 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  pairs.shouldAvoid('alice', 'bob'); // triggers lazy cleanup
  assert.equal(pairs.size(), 0);
});

test('sweep() reclaims expired entries that were never looked up again', async () => {
  const pairs = createAvoidPairs(20);
  pairs.add('alice', 'bob');
  pairs.add('alice', 'carol');
  assert.equal(pairs.size(), 2);
  await new Promise((resolve) => setTimeout(resolve, 40));
  pairs.sweep();
  assert.equal(pairs.size(), 0);
});

test('unrelated pairs are unaffected by another pair expiring', async () => {
  const pairs = createAvoidPairs(20);
  pairs.add('alice', 'bob');
  await new Promise((resolve) => setTimeout(resolve, 40));
  pairs.add('alice', 'carol'); // fresh, should not be expired
  assert.equal(pairs.shouldAvoid('alice', 'bob'), false);
  assert.equal(pairs.shouldAvoid('alice', 'carol'), true);
});
