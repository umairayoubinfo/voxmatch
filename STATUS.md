# VoxMatch — Status Report

## What this app is
A random voice-chat web app (Omegle-style, voice-first): click Start, get
matched with a random online stranger, talk over a live WebRTC audio call.
Includes skip/next, text chat, and a report/ban moderation pipeline.

## Stack
- **Server**: Node.js + Express + Socket.IO (matchmaking + WebRTC signaling relay)
- **Persistence**: Redis (for bans, reports, rate limits — survives restarts/deploys)
- **Client**: Vanilla HTML/CSS/JS, `RTCPeerConnection` + `getUserMedia`
- **Identity**: anonymous, server-issued signed httpOnly cookie (not client-controlled)

## Features implemented

| Feature | Status | Notes |
|---|---|---|
| Random 1:1 matchmaking | Done | In-memory waiting queue, pairs two free sockets into a room |
| WebRTC voice call | Done | STUN + TURN configured (OpenRelay free shared TURN — see caveat below) |
| Skip / Next stranger | Done | Leaves current room, re-queues immediately |
| Stop | Done | Ends call, releases microphone |
| Text chat | Done | Relayed only to your current partner, not stored anywhere |
| Report button | Done | Flags partner's identity; 3 reports in 7 days → 24h ban, persisted in Redis |
| Consent/age gate | Done | Checkbox ("18+, agree to ToS") gates the Start button |
| Terms of Service page | Done (placeholder text) | `public/terms.html` — **not lawyer-reviewed, see caveat below** |
| Hardened anonymous identity | Done | Signed httpOnly cookie issued server-side; clearing `localStorage` no longer resets a ban (clearing cookies still does) |
| Rate limiting | Done | `find-partner` capped 20/min, `report` capped 5/10min, per identity+IP, via Redis |
| Dynamic ICE config | Done | `/ice-config` mints short-lived Cloudflare Realtime TURN credentials server-side (`lib/cloudflareTurn.js`) when `CLOUDFLARE_TURN_KEY_ID`/`CLOUDFLARE_TURN_API_TOKEN` are set, falling back to static `TURN_URLS` env vars otherwise; client fetches it at runtime |
| Admin report review | Done | `GET /admin/reports`, `POST /admin/unban/:id` — bearer-token protected, JSON only, no UI |
| Health check | Done | `GET /healthz` — pings Redis, for use as a host health-check endpoint |
| Security headers | Done | `helmet` middleware |
| Structured logging | Done | `pino` / `pino-http` replacing `console.log` |
| Graceful shutdown | Done | `SIGTERM` handler closes server + Redis cleanly |
| HTTPS/TLS | Not yet | Will come free from the hosting platform (Render) once deployed; not needed for `localhost` |
| Real user accounts | Not built (by design) | Decided to stay anonymous-but-hardened rather than add signup/login |
| Multi-instance scaling | Not built | Matchmaking queue is single-process in-memory; documented as a known limitation in README |
| Audio/content moderation | Not built | Only behavioral signal (user reports) feeds the ban system — no automated detection |

## Can it be launched right now?

**Deployed and running on Render. Not yet sized/configured for real public traffic — see below.**

### Resolved
- **`REDIS_URL`** — connected to a live Upstash instance; `/healthz` confirms it.
- **TURN server (code side)** — `/ice-config` now mints short-lived credentials
  from Cloudflare Realtime TURN (`lib/cloudflareTurn.js`) once
  `CLOUDFLARE_TURN_KEY_ID`/`CLOUDFLARE_TURN_API_TOKEN` are set — a dedicated
  provider with a generous free tier (1,000 GB/month relayed), not a shared
  pool. **Code is ready; the Cloudflare account/app and Render env vars still
  need to be set up** — see "Still needed" below.
- **Terms of Service** — reviewed/updated since the placeholder version
  flagged here previously.
- **End-to-end flow test** — driven via two headless Chromium tabs (fake mic
  input): matchmaking, WebRTC audio (`ontrack` fired both directions), text
  chat relay, and skip/requeue all verified working against the real server
  and real Redis.

### Still needed before any real/public launch
- **Cloudflare Realtime TURN account setup** — sign up, create a Realtime TURN
  app, and set `CLOUDFLARE_TURN_KEY_ID`/`CLOUDFLARE_TURN_API_TOKEN` in Render's
  environment variables. Until these are set, `/ice-config` falls back to
  whatever's in `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL` — currently
  OpenRelay's free *shared* credentials, which are publicly known and can be
  throttled or revoked without notice.
- **Render is still on the Free instance type.** It sleeps after 15 min idle
  (cold start ~1 min on the next request) and has 0.1 CPU / 512MB RAM —
  documented as fine for early/low traffic, not for "click Start, talk now" at
  any real volume. Upgrade to Starter (~$7/mo) via Render's dashboard before a
  real launch; Standard (~$25/mo) if `npm run load-test` shows Starter
  struggling under your expected concurrency.
- **Upstash Redis is still on the free tier** (500K commands/month). Matchmaking
  costs ~2-3 Redis commands per `find-partner` click — a moderately active
  userbase can exceed the free monthly budget well before Render or TURN
  becomes the bottleneck. Watch the Upstash dashboard; pay-as-you-go overage
  is cheap (~$0.20/100K commands) if/when you cross it.

### Lower priority, not blocking an early/small launch
- **Multi-instance scaling** — matchmaking queue is single-process in-memory;
  documented as a known limitation. Matters once you'd run more than one
  server instance, not before.
- **Manual test with a real microphone in a real browser** — the automated
  test used Chromium's fake-media-device flags, not actual mic hardware. Worth
  a quick sanity check by hand before a public launch, though the automated
  result is strong evidence the WebRTC path itself works.

## Summary
The code is feature-complete for a "minimum viable, anonymous, cheap-to-host"
random voice chat app, deployed and verified end-to-end against real
infrastructure. What's left before real public traffic is account/config
work, not code: set up the Cloudflare Realtime TURN app and its env vars,
upgrade Render off the Free instance type, and keep an eye on the Upstash
free-tier command budget as usage grows.
