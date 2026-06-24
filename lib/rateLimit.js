// Fixed-window rate limiter backed by Redis (INCR + EXPIRE-on-first-increment).
// Returns true if the call is within budget, false if the caller is over the limit.
async function checkRateLimit(redis, key, max, windowSeconds) {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  return count <= max;
}

module.exports = { checkRateLimit };
