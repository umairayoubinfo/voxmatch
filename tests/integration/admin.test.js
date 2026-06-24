require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../helpers/testServer');

const PORT = 3503;
let server;

before(async () => {
  server = await startTestServer(PORT);
});

after(async () => {
  await server.stop();
});

test('admin endpoints reject requests with no Authorization header', async () => {
  const res = await fetch(`${server.baseUrl}/admin/reports`);
  assert.equal(res.status, 401);
});

test('admin endpoints reject an incorrect bearer token', async () => {
  const res = await fetch(`${server.baseUrl}/admin/reports`, {
    headers: { Authorization: 'Bearer definitely-the-wrong-secret' },
  });
  assert.equal(res.status, 401);
});

test('admin endpoints accept the correct bearer token', async () => {
  assert.ok(process.env.ADMIN_SECRET, 'ADMIN_SECRET must be set in .env to run this test');
  const res = await fetch(`${server.baseUrl}/admin/reports`, {
    headers: { Authorization: `Bearer ${process.env.ADMIN_SECRET}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.reports));
});

test('unban endpoint requires auth too', async () => {
  const res = await fetch(`${server.baseUrl}/admin/unban/some-test-id`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('unban endpoint succeeds with the correct token', async () => {
  const res = await fetch(`${server.baseUrl}/admin/unban/some-test-id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.ADMIN_SECRET}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});
