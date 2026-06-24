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
| Dynamic ICE config | Done | `/ice-config` endpoint serves STUN+TURN from env vars; client fetches it at runtime |
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

**It runs locally end-to-end now. Not yet ready for a real/public launch — three items remain.**

### Resolved
- **`REDIS_URL`** — connected to a live Upstash instance; `/healthz` confirms it.
- **TURN server** — configured with OpenRelay's free shared credentials
  (`TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL` in `.env`). Fine for testing,
  but see caveat below before relying on it for real traffic.
- **End-to-end flow test** — driven via two headless Chromium tabs (fake mic
  input): matchmaking, WebRTC audio (`ontrack` fired both directions), text
  chat relay, and skip/requeue all verified working against the real server
  and real Redis.

### Strongly recommended before any real/public launch
- **TURN is on OpenRelay's free *shared* credentials**, not a dedicated/paid
  server. These are publicly known, rate-limited, and can be throttled or
  revoked without notice. Fine for development; swap for a paid TURN tier
  (e.g. [metered.ca](https://www.metered.ca/)) or self-hosted coturn before
  treating this as production.
- **Not deployed anywhere yet** — currently only runs on `localhost`. To put it
  on the internet you'd push this repo to GitHub and deploy to Render (or
  similar) as described in `README.md`. `getUserMedia` requires HTTPS for any
  non-localhost origin, which Render provides automatically.
- **Terms of Service text is a placeholder, not lawyer-reviewed.** This app is
  in the same risk category as Omegle/Chatroulette (anonymous stranger voice
  chat) — both of which had serious legal/regulatory exposure over abuse and
  CSAM. The ToS, consent gate, and report/ban pipeline built here are a
  reasonable technical baseline, not a substitute for actual legal review.
  **Get a lawyer to review `public/terms.html` and the moderation/retention
  approach before treating this as a real public launch.**

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
random voice chat app per the plan we agreed on, and now runs and has been
verified end-to-end locally. Before a real public launch: move off the free
shared TURN credentials, deploy with HTTPS, and get the ToS legally reviewed.
