// Fetches short-lived TURN/STUN credentials from Cloudflare Realtime TURN
// (https://developers.cloudflare.com/realtime/turn/) and caches them
// in-memory so /ice-config doesn't call Cloudflare's API on every page load.
// Credentials are requested with a 24h TTL and re-minted 2h before expiry.
// Returns null (caller falls back to static STUN/TURN config) when
// Cloudflare isn't configured or the API call fails — this is a plain HTTP
// endpoint, not the synchronous WebRTC signal relay, so an external call
// here is fine (see SECURITY.md invariant #5, which only applies to the
// 'signal' socket handler).
const CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;
const REFRESH_MARGIN_MS = 2 * 60 * 60 * 1000;

let cached = null; // { iceServers, expiresAt }

async function fetchIceServers(logger) {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !apiToken) return null;

  if (cached && Date.now() < cached.expiresAt) {
    return cached.iceServers;
  }

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
      }
    );
    if (!res.ok) throw new Error(`Cloudflare TURN API responded ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
      throw new Error('Cloudflare TURN API returned no iceServers');
    }
    cached = {
      iceServers: data.iceServers,
      expiresAt: Date.now() + CREDENTIAL_TTL_SECONDS * 1000 - REFRESH_MARGIN_MS,
    };
    return cached.iceServers;
  } catch (err) {
    logger?.error({ err: err.message }, 'Cloudflare TURN credential fetch failed');
    return null;
  }
}

module.exports = { fetchIceServers };
