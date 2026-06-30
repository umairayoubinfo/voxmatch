# VoxMatch

Random voice chat — click Start, get paired with a random online stranger over a
live WebRTC audio call. Includes Skip/Next, text chat, and report/ban moderation
backed by Redis so it survives restarts and deploys.

## Stack

- **Server**: Node.js + Express + Socket.IO (matchmaking and WebRTC signaling
  relay). Live matchmaking queue and active sessions are in-process memory
  (tied to live socket connections anyway). Reports, bans, and rate-limit
  counters persist in Redis.
- **Client**: Vanilla HTML/CSS/JS, `RTCPeerConnection` + `getUserMedia`, with
  STUN + TURN servers fetched at runtime from `/ice-config`.
- **Identity**: anonymous, but server-issued — a signed httpOnly cookie, not a
  client-controlled `localStorage` value, so clearing browser storage alone no
  longer resets your identity for ban purposes.

## ⚠️ Before any real public launch

This is an anonymous random-stranger voice chat app — the same risk category as
Omegle/Chatroulette, both of which faced serious legal and regulatory trouble
over abuse and CSAM. What's built here (age-gate checkbox, ToS link, report/ban
pipeline, rate limiting) is a reasonable **technical** baseline, not a substitute
for actual legal review. **Have a lawyer review `public/terms.html` and your
moderation/data-retention approach before treating this as a real launch.**

## One-time account setup (required — I can't create these for you)

You need three free-tier accounts before this will run against real
infrastructure:

1. **Redis — [Upstash](https://upstash.com)**
   - Sign up free → create a Redis database → copy the `rediss://...`
     connection string it gives you.
   - For local development only, you can instead point `REDIS_URL` at any
     Redis-compatible instance you already have running.

2. **TURN — [Cloudflare Realtime](https://developers.cloudflare.com/realtime/turn/)**
   (recommended) or any other TURN provider
   - Sign up for Cloudflare → create a Realtime TURN app → copy the Turn Key
     ID and API token it gives you. `lib/cloudflareTurn.js` mints short-lived
     credentials from these server-side; nothing client-facing is static.
   - Generous free tier (1,000 GB/month relayed) — comfortably covers a real
     launch without paying anything, see `STATUS.md` for the math.
   - Without TURN configured at all, calls between users on restrictive
     networks (symmetric NAT, some corporate/mobile firewalls) will fail to
     connect — STUN alone isn't enough for everyone.
   - If you'd rather use a different/static-credential TURN provider (e.g.
     [Metered.ca](https://www.metered.ca/tools/openrelay/)), set `TURN_URLS`/
     `TURN_USERNAME`/`TURN_CREDENTIAL` instead — see Environment variables
     below. That path is used automatically whenever the Cloudflare vars are
     unset.

3. **Hosting — [Render](https://render.com)** (or Fly.io/Railway)
   - Push this repo to GitHub.
   - Render → New → Web Service → connect the repo.
   - Set the environment variables below in Render's dashboard.
   - Choose the **Starter** plan (~$7/mo), not Free — the Free tier cold-starts
     and sleeps when idle, which breaks a "click Start, talk now" app.
   - Render auto-provisions TLS on your `*.onrender.com` domain, which
     `getUserMedia` requires for any non-localhost origin.

## Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (most hosts set this for you) |
| `REDIS_URL` | Connection string from Upstash (or your own Redis) |
| `COOKIE_SECRET` | Random secret signing the identity cookie — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_SECRET` | Bearer token required to call `/admin/*` — generate the same way |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | From your Cloudflare Realtime TURN app — preferred TURN config, see above |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Fallback TURN config (any static-credential provider), used only when the Cloudflare vars above are unset |

## Run locally

```
npm install
npm start
```

Open `http://localhost:3000` in two separate browser profiles (e.g. normal +
incognito, since each needs its own microphone permission prompt and its own
identity cookie). Check the consent box, click **Start** in both — they should
match and you'll hear live audio both ways.

## Features

- **Start** — gated on the consent checkbox; requests mic access, joins the
  matchmaking queue.
- **Skip** — leaves the current call and immediately re-queues for a new
  stranger.
- **Report** — flags your current partner by their server-issued identity and
  disconnects you both. After 3 reports in a 7-day window, that identity is
  banned from matching for 24 hours. Reporters also avoid being re-matched with
  someone they've already reported (for the life of the server process).
- **Stop** — ends the call/search and releases the microphone.
- **Text chat** — a simple relayed side channel while connected to a partner.
- **Rate limiting** — `find-partner` capped at 20/minute per identity+IP;
  `report` capped at 5 per 10 minutes per identity, so reporting can't itself be
  used as a denial-of-service tool against innocent users.

## Admin endpoints

Protected by `Authorization: Bearer <ADMIN_SECRET>`:

- `GET /admin/reports` — recent report log (up to 500 entries).
- `POST /admin/unban/:id` — clears a ban and resets the report count for that
  identity.

There's no admin UI — these are plain JSON endpoints, intentionally minimal.

## Operational endpoints

- `GET /healthz` — pings Redis, returns 200 if healthy, 503 if Redis is
  unreachable. Point your host's health check here.

## Load testing

`scripts/loadtest.js` simulates N concurrent users hitting matchmaking/signal/
chat against a real running server, then reports connect/match-latency/error
stats:

```
npm run load-test -- --url=https://your-app.onrender.com --clients=1000
```

It exercises the matchmaking server and Redis-backed rate limits — it does
**not** exercise real WebRTC audio or TURN relay (audio never passes through
this server), so it can't tell you whether your TURN provider holds up under
load, only whether matchmaking/signaling does.

## Limitations / known gaps

- **Single-instance only.** The live matchmaking queue and active sessions are
  in-process memory. If you ever need more than one server instance (for
  scale), the queue itself needs a Redis-backed atomic pop (e.g. a Lua script)
  to avoid two instances double-matching the same waiting user — not built yet.
- **Anonymous identity is hardened, not bulletproof.** Clearing cookies (not
  just `localStorage`) still resets a user's identity. IP-based rate limiting
  raises the cost of evasion but doesn't eliminate it.
- **No content moderation of audio itself** — only behavioral signals (reports)
  feed the ban system. There's no real-time audio/abuse detection.
- **No persistent user accounts** — by design, per the anonymous-but-hardened
  approach. If real ban durability across identity resets becomes necessary,
  the next step up is real accounts (email/OAuth).
