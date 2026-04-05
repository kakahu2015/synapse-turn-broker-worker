# synapse-turn-broker-worker

Cloudflare Worker + KV implementation of a Synapse TURN credential broker.

Zero servers to maintain. Deploys to Cloudflare's edge for global low-latency access.

## How it works

```
Synapse  →  POST /credentials  →  Worker (edge)
                                      │
                                      ├─ KV cache hit? → return cached creds
                                      │
                                      └─ cache miss → CF TURN API → cache in KV → return creds
```

## Free tier friendly

- **Cloudflare Workers**: 100k requests/day free
- **KV**: 100k reads/day, 1k writes/day free
- TURN credential requests are infrequent (only during call setup)

## Setup

### 1. Install wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Create KV namespace

```bash
wrangler kv namespace create TURN_CACHE
```

Copy the `id` from the output and paste it into `wrangler.toml` → `[[kv_namespaces]]` → `id`.

### 3. Set secrets

```bash
# The Bearer token Synapse will send to authenticate
wrangler secret put BROKER_TOKEN

# Your Cloudflare TURN key ID
wrangler secret put CF_TURN_KEY_ID

# Your Cloudflare TURN API token
wrangler secret put CF_TURN_API_TOKEN
```

### 4. Deploy

```bash
wrangler deploy
```

You'll get a URL like `synapse-turn-broker.your-account.workers.dev`.

### 5. Configure Synapse

In `homeserver.yaml`:

```yaml
voip:
  turn_mode: broker
  turn_federation_deployment: true
  turn_broker_url: https://synapse-turn-broker.your-account.workers.dev/credentials
  turn_broker_api_token_path: /path/to/broker-token-file
```

Restart Synapse. Done.

## API

### `POST /credentials`

Request:
```json
{ "ttl": 3600 }
```

Headers:
```
Authorization: Bearer <BROKER_TOKEN>
```

Response (Matrix TURN format):
```json
{
  "username": "...",
  "password": "...",
  "ttl": 3600,
  "uris": ["turn:turn.cloudflare.com:3478?transport=udp", ...]
}
```

### `GET /healthz`

Returns `ok` for health checks.

## Configuration

| Env var | Required | Default | Description |
|---------|----------|---------|-------------|
| `BROKER_TOKEN` | No | — | Bearer token for auth (omit to skip auth) |
| `CF_TURN_KEY_ID` | Yes | — | Cloudflare TURN key ID |
| `CF_TURN_API_TOKEN` | Yes | — | Cloudflare TURN API token |
| `CF_TURN_BASE_URL` | No | `https://rtc.live.cloudflare.com/v1` | CF TURN API base URL |
| `MAX_TTL` | No | `3600` | Max allowed TTL in seconds |
| `BUCKET_SEC` | No | `30` | Time bucket size for credential caching |

## Security

- Bearer token auth with constant-time comparison
- Secrets stored as Wrangler secrets (encrypted, never in code)
- KV cache auto-expires after bucket window + 10s margin
- Port 53 TURN URLs filtered (browsers time out on :53)
- No sensitive data in responses beyond the TURN credentials themselves
