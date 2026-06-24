# VoxMatch — Security Baseline

This is the security floor for this app: controls listed here must not be
weakened, removed, or silently bypassed by a future change — including by an
AI agent under feature-delivery pressure. Strengthening anything here is
always fine. Loosening anything here requires the owner's explicit, separate
sign-off before the change goes in, not a passing mention in a PR description.

## Invariants (do not weaken without explicit owner sign-off)

1. **Identity stays server-issued, signed, httpOnly.** (`lib/identity.js`)
   Never move identity into client-readable storage (`localStorage`,
   non-httpOnly cookie). Signature verification must stay constant-time
   (`crypto.timingSafeEqual`), not `===`.
2. **Admin endpoints use constant-time auth.** (`server.js: requireAdmin`,
   `lib/auth.js: safeCompare`) Bearer token comparison must use
   `safeCompare`/`timingSafeEqual`, never a plain `===` string comparison.
3. **Self-match prevention can't be removed.** (`server.js: tryMatch`) A
   socket must never be paired with another socket of the same identity.
4. **Rate limits stay in place on `find-partner`, `report`, `signal`, and
   `chat-message`.** Thresholds can be tuned; the checks themselves must not
   be deleted. `signal` and `chat-message` are intentionally rate-limited
   in-memory per-socket (`lib/localRateLimit.js`), not via Redis — see #5.
5. **No awaited external call (Redis, DB, HTTP) in the `signal` relay
   handler.** We hit this directly while hardening this app: making the
   handler `async` and awaiting a Redis round-trip per message reordered
   relayed WebRTC signaling (ICE candidates arrived before the offer/answer,
   producing `addIceCandidate` failures). That handler must stay synchronous
   and in-memory.
6. **Secrets never get logged.** `ADMIN_SECRET`, `COOKIE_SECRET`,
   `REDIS_URL`, and raw identity cookie values must never appear in pino
   output or error messages.
7. **`.env` stays gitignored.** Secrets are supplied only via environment
   variables — never hardcoded, never committed.
8. **No public launch without HTTPS and a dedicated (non-shared) TURN
   credential.** The free OpenRelay shared TURN credentials in `.env.example`
   are for local development only.

## What's already implemented

| Control | Where |
|---|---|
| Signed, httpOnly, anonymous identity cookie | `lib/identity.js` |
| Self-match prevention | `server.js: tryMatch` |
| Report → ban pipeline (3 reports/7d → 24h ban), Redis-persisted | `server.js`, survives restarts/deploys |
| Rate limiting: `find-partner` 20/min, `report` 5/10min (Redis, per identity+IP) | `lib/rateLimit.js` |
| Rate limiting: `signal` 300/min, `chat-message` 30/30s (in-memory, per-socket) | `lib/localRateLimit.js` |
| Constant-time admin auth | `server.js: requireAdmin` / `lib/auth.js: safeCompare` |
| Security headers (CSP, HSTS, etc.) | `helmet` middleware |
| Structured logging, no secrets in output | `pino` / `pino-http` |
| Consent/age-gate before Start | `public/index.html` |
| Automated test suite (unit + integration) | `npm test` — see `tests/` |

## Known, accepted gaps (tracked, not hidden)

These are real and intentional — see `README.md` / `STATUS.md` for the full
writeup. Don't treat their existence as something to quietly "fix" by
weakening something else above; they require their own dedicated work:

- TURN currently uses OpenRelay's free *shared* credentials — fine for dev,
  not for real traffic.
- Terms of Service text is a placeholder, not lawyer-reviewed.
- Matchmaking queue is single-process in-memory — no multi-instance support.
- No automated audio/content moderation — only behavioral signal (reports).
- Clearing cookies (not just `localStorage`) still resets a user's identity,
  which resets ban history for that user.

## Process

Before touching anything in the **Invariants** section above, stop and ask
the owner explicitly — don't infer consent from "make it more secure" or
similar general instructions. General hardening requests should add to this
list, not edit around it.
