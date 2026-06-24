const test = require('node:test');
const assert = require('node:assert/strict');
const { safeCompare } = require('../../lib/auth');

test('returns true for identical strings', () => {
  assert.equal(safeCompare('correct-secret', 'correct-secret'), true);
});

test('returns false for different strings of the same length', () => {
  assert.equal(safeCompare('correct-secret', 'wrong--secret'), false);
});

test('returns false for different-length strings (no length-mismatch throw)', () => {
  assert.equal(safeCompare('short', 'a-much-longer-secret-value'), false);
});

test('returns false for an empty candidate against a real secret', () => {
  assert.equal(safeCompare('', 'correct-secret'), false);
});
