// Tracks "don't re-match these two identities" pairs created by reports.
// Previously this lived as a plain Map in server.js with no expiry, so it grew
// for the entire life of the process. That outlives the actual report data in
// Redis (which expires after REPORT_TTL_SECONDS) — a reported identity could
// stay avoided in-memory long after Redis had forgotten the report entirely.
// This version expires entries on the same schedule as the Redis report TTL.
function createAvoidPairs(ttlMs) {
  const store = new Map(); // reporterIdentity -> Map<reportedIdentity, expiresAtMs>

  function add(reporterIdentity, reportedIdentity) {
    if (!store.has(reporterIdentity)) store.set(reporterIdentity, new Map());
    store.get(reporterIdentity).set(reportedIdentity, Date.now() + ttlMs);
  }

  function isAvoided(reporterIdentity, reportedIdentity) {
    const entries = store.get(reporterIdentity);
    if (!entries) return false;
    const expiresAt = entries.get(reportedIdentity);
    if (expiresAt === undefined) return false;
    if (Date.now() >= expiresAt) {
      entries.delete(reportedIdentity);
      if (entries.size === 0) store.delete(reporterIdentity);
      return false;
    }
    return true;
  }

  function shouldAvoid(identityA, identityB) {
    return isAvoided(identityA, identityB) || isAvoided(identityB, identityA);
  }

  // Drops expired entries that were never looked up again via shouldAvoid,
  // so memory doesn't grow indefinitely from one-off reported pairs.
  function sweep() {
    const now = Date.now();
    for (const [reporter, entries] of store) {
      for (const [reported, expiresAt] of entries) {
        if (now >= expiresAt) entries.delete(reported);
      }
      if (entries.size === 0) store.delete(reporter);
    }
  }

  function size() {
    let total = 0;
    for (const entries of store.values()) total += entries.size;
    return total;
  }

  return { add, shouldAvoid, sweep, size };
}

module.exports = { createAvoidPairs };
