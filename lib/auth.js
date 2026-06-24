const crypto = require('crypto');

// Constant-time string comparison — never use === for secrets (timing attack).
function safeCompare(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

module.exports = { safeCompare };
