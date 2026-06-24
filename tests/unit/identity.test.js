const test = require('node:test');
const assert = require('node:assert/strict');

process.env.COOKIE_SECRET = 'test-cookie-secret-do-not-use-in-prod';
const { ensureIdentity, identityFromSocket, COOKIE_NAME } = require('../../lib/identity');

function fakeReqRes(cookieHeader) {
  const req = { headers: { cookie: cookieHeader }, secure: false };
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; } };
  return { req, res };
}

test('issues a signed cookie when none is present', () => {
  const { req, res } = fakeReqRes(undefined);
  ensureIdentity(req, res, () => {});
  assert.ok(req.identity, 'req.identity should be set');
  assert.ok(res.headers['Set-Cookie'].includes(COOKIE_NAME));
});

test('reuses a valid existing cookie instead of issuing a new one', () => {
  const { req: req1, res: res1 } = fakeReqRes(undefined);
  ensureIdentity(req1, res1, () => {});
  const setCookie = res1.headers['Set-Cookie'];
  const cookiePair = setCookie.split(';')[0]; // "vm_id=<value>"

  const { req: req2, res: res2 } = fakeReqRes(cookiePair);
  ensureIdentity(req2, res2, () => {});

  assert.equal(req2.identity, req1.identity);
  assert.equal(res2.headers['Set-Cookie'], undefined, 'should not reissue a cookie');
});

test('rejects a tampered cookie and issues a fresh identity instead', () => {
  const { req: req1, res: res1 } = fakeReqRes(undefined);
  ensureIdentity(req1, res1, () => {});
  const [name, value] = res1.headers['Set-Cookie'].split(';')[0].split('=');
  // Flip the last hex char of the signature to something it's guaranteed not
  // to already be, so this can't accidentally produce an identical cookie.
  const lastChar = value.slice(-1);
  const flipped = lastChar === '0' ? '1' : '0';
  const tamperedValue = value.slice(0, -1) + flipped;

  const { req: req2, res: res2 } = fakeReqRes(`${name}=${tamperedValue}`);
  ensureIdentity(req2, res2, () => {});

  assert.notEqual(req2.identity, req1.identity);
  assert.ok(res2.headers['Set-Cookie'], 'a fresh cookie should be issued for a tampered one');
});

test('identityFromSocket reads the same signed cookie format', () => {
  const { req, res } = fakeReqRes(undefined);
  ensureIdentity(req, res, () => {});
  const cookiePair = res.headers['Set-Cookie'].split(';')[0];

  const socket = { handshake: { headers: { cookie: cookiePair } } };
  assert.equal(identityFromSocket(socket), req.identity);
});

test('identityFromSocket returns null when there is no cookie', () => {
  const socket = { handshake: { headers: {} } };
  assert.equal(identityFromSocket(socket), null);
});
