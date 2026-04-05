/**
 * Synapse TURN Broker (Cloudflare Worker + KV)
 *
 * Accepts POST /credentials from Synapse, mints short-lived TURN credentials
 * from Cloudflare Realtime TURN, caches them in KV, and returns Matrix-style
 * TURN credentials.
 *
 * Env vars (set in wrangler.toml or dashboard):
 *   BROKER_TOKEN        — Bearer token for Synapse auth
 *   CF_TURN_KEY_ID      — Cloudflare TURN key ID
 *   CF_TURN_API_TOKEN   — Cloudflare TURN API token
 *   CF_TURN_BASE_URL    — (optional) defaults to https://rtc.live.cloudflare.com/v1
 *   MAX_TTL             — (optional) max allowed TTL in seconds, default 3600
 *   BUCKET_SEC          — (optional) time bucket size in seconds, default 30
 *
 * KV binding: TURN_CACHE
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    // Only POST /credentials
    if (request.method !== "POST" || url.pathname !== "/credentials") {
      return new Response("Not Found", { status: 404 });
    }

    // Auth
    const token = env.BROKER_TOKEN;
    if (token) {
      const authHeader = request.headers.get("Authorization") || "";
      const provided = authHeader.replace(/^Bearer\s+/i, "");
      if (!timingSafeEqual(provided, token)) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    // Parse request
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const requestedTtl = typeof body.ttl === "number" ? body.ttl : 3600;
    const maxTtl = parseInt(env.MAX_TTL || "3600", 10);
    const ttl = Math.min(requestedTtl, maxTtl);
    const bucketSec = parseInt(env.BUCKET_SEC || "30", 10);

    // Time bucket key
    const now = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(now / bucketSec);
    const cacheKey = `turn:${bucket}`;

    // Try KV cache first
    let credentials = null;
    if (env.TURN_CACHE) {
      try {
        const cached = await env.TURN_CACHE.get(cacheKey, { type: "json" });
        if (cached && cached.username && cached.password && cached.uris) {
          credentials = cached;
        }
      } catch {
        // KV read failure — fall through to mint new credentials
      }
    }

    // Mint new credentials on cache miss
    if (!credentials) {
      try {
        credentials = await mintCloudflareTurnCredentials(env, ttl);
      } catch (err) {
        return new Response(
          JSON.stringify({ error: "upstream failure", detail: err.message }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        );
      }

      // Store in KV (expires slightly after the bucket ends)
      if (env.TURN_CACHE) {
        try {
          await env.TURN_CACHE.put(cacheKey, JSON.stringify(credentials), {
            expirationTtl: bucketSec + 10,
          });
        } catch {
          // KV write failure — non-fatal, response still valid
        }
      }
    }

    // Clamp returned TTL
    const responseTtl = Math.min(credentials.ttl || ttl, ttl);

    return new Response(
      JSON.stringify({
        username: credentials.username,
        password: credentials.password,
        ttl: responseTtl,
        uris: credentials.uris,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  },
};

/**
 * Call Cloudflare Realtime TURN API to mint ICE server credentials.
 */
async function mintCloudflareTurnCredentials(env, ttl) {
  const keyId = env.CF_TURN_KEY_ID;
  const apiToken = env.CF_TURN_API_TOKEN;
  const baseUrl = (env.CF_TURN_BASE_URL || "https://rtc.live.cloudflare.com/v1").replace(/\/+$/, "");

  if (!keyId || !apiToken) {
    throw new Error("CF_TURN_KEY_ID and CF_TURN_API_TOKEN are required");
  }

  const uri = `${baseUrl}/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;

  const resp = await fetch(uri, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl }),
  });

  if (!resp.ok) {
    throw new Error(`Cloudflare TURN API returned ${resp.status}`);
  }

  const data = await resp.json();
  return parseCloudflareTurnResponse(data, ttl);
}

/**
 * Parse Cloudflare TURN response into Matrix TURN format.
 */
function parseCloudflareTurnResponse(response, ttl) {
  const iceServers = response.iceServers;
  if (!Array.isArray(iceServers)) {
    throw new Error("Cloudflare response missing iceServers");
  }

  const turnUris = [];
  let username = null;
  let password = null;

  for (const server of iceServers) {
    if (!server || typeof server !== "object") continue;

    const urls = typeof server.urls === "string" ? [server.urls] : Array.isArray(server.urls) ? server.urls : [];
    const turnUrls = urls.filter(
      (u) => typeof u === "string" && (u.startsWith("turn:") || u.startsWith("turns:")) && !u.split("?")[0].includes(":53")
    );
    if (turnUrls.length === 0) continue;

    const iceUser = server.username;
    const icePass = server.credential;
    if (typeof iceUser !== "string" || typeof icePass !== "string") continue;

    if (username === null) {
      username = iceUser;
      password = icePass;
    } else if (username !== iceUser || password !== icePass) {
      throw new Error("Cloudflare response contained multiple credential sets");
    }

    for (const uri of turnUrls) {
      if (!turnUris.includes(uri)) turnUris.push(uri);
    }
  }

  if (!username || !password || turnUris.length === 0) {
    throw new Error("Cloudflare response did not include TURN credentials");
  }

  return { username, password, ttl, uris: turnUris };
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
