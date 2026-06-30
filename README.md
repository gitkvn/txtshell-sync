# txtshell-sync

A Cloudflare Worker providing encrypted blob storage and an append-only inbox for [Txtshell](https://txtshell.com). It is a **thin storage layer**: it stores and returns ciphertext, and never decrypts, inspects, or logs your data.

## What this is

- **Single-user, self-hosted.** Each user deploys their own Worker on their own Cloudflare account. There is no central Txtshell-operated backend.
- **End-to-end encrypted.** All encryption and decryption happen in the Txtshell client. The Worker only ever sees ciphertext.
- **Minimal surface.** R2 storage only — no Durable Objects, KV, or D1. Stateless beyond R2.

If you don't run a Worker, Txtshell still works as a pure local-first tool with encrypted export for cross-device transfer. The Worker is optional sync infrastructure.

## Endpoints

All endpoints are versioned under `/v1`. Auth is required on all of them (see [Authentication](#authentication)).

| Method   | Path          | Purpose                              |
| -------- | ------------- | ------------------------------------ |
| `PUT`    | `/v1/blocks`  | Overwrite the encrypted blocks blob  |
| `GET`    | `/v1/blocks`  | Fetch the encrypted blocks blob      |
| `POST`   | `/v1/inbox`   | Append an encrypted inbox entry      |
| `GET`    | `/v1/inbox`   | Fetch the full inbox                 |
| `DELETE` | `/v1/inbox`   | Remove specified entry IDs from inbox |

### Request/response shapes

**`PUT /v1/blocks`** — Body: raw encrypted bytes. → `200 { "ok": true }`

**`GET /v1/blocks`** — → `200` raw bytes, `Content-Type: application/octet-stream`. If no blob exists: `404 { "error": "no-blob", ... }`.

**`POST /v1/inbox`** — Body: JSON `{ id, ciphertext, iv, createdAt }` (all strings). → `200 { "id": "...", "accepted": true }`. If the inbox already holds 1000+ entries: `413 { "error": "inbox-full", ... }`.

**`GET /v1/inbox`** — → `200` JSON array of entries (or `[]` if none).

**`DELETE /v1/inbox`** — Body: JSON `{ "ids": ["..."] }`. → `200 { "removed": <n>, "remaining": <n> }`.

### Error format

All errors use a consistent JSON shape — switch on `error`, display `message`:

```json
{ "error": "machine-readable-code", "message": "Human readable explanation" }
```

| Status | `error` code           | When                                          |
| ------ | ---------------------- | --------------------------------------------- |
| 400    | `https-required`       | Request not over HTTPS                         |
| 400    | `bad-request`          | Malformed JSON or invalid body shape          |
| 401    | `unauthorized`         | Missing or invalid bearer token               |
| 403    | `forbidden-origin`     | `Origin` header not in the allow-list         |
| 404    | `no-blob`              | `GET /v1/blocks` with no stored blob          |
| 404    | `not-found`            | Unknown path                                  |
| 405    | `method-not-allowed`   | Unsupported method (globally or on that path) |
| 413    | `payload-too-large`    | Body exceeds the 5MB limit                    |
| 413    | `inbox-full`           | Inbox at 1000-entry capacity                  |
| 500    | `internal-error`       | Unexpected failure (e.g. corrupt stored state) |

## Authentication

Every request must include:

```
Authorization: Bearer <token>
```

- A single shared token per Worker (v1). Set either via the Deploy-to-Cloudflare button's AUTH_SECRET field (Path A) or with `wrangler secret put AUTH_SECRET` (Path B / rotation).
- The token is compared in constant time to defend against timing attacks.
- The token is accepted **only** via the `Authorization` header — never query parameters, body fields, or cookies. Any request lacking a valid bearer token gets `401`.

CORS: browser requests are accepted only from `https://txtshell.com`, `https://www.txtshell.com`, and `http://localhost:8080`. Requests with no `Origin` header (curl, native iOS app) pass the origin check and still require auth.

## Setup

### Path A — Deploy to Cloudflare button (recommended for most users)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gitkvn/txtshell-sync)

Clicking the button has Cloudflare fork the repo to your account, provision the R2 bucket from `wrangler.toml`, deploy the Worker, and set up auto-deploy on future pulls. During the deploy, Cloudflare prompts for **AUTH_SECRET** as a field — paste a generated random value there (e.g. the output of `openssl rand -hex 32`, or any long random string from a password manager). No terminal needed for Path A; keep a copy of the value to paste into Txtshell.

Paste the resulting Worker URL into Txtshell.

### Path B — Manual CLI setup

```bash
# 1. Install wrangler if you don't have it
npm install -g wrangler

# 2. Authenticate with your Cloudflare account
wrangler login

# 3. Clone the Worker repo
git clone https://github.com/gitkvn/txtshell-sync.git
cd txtshell-sync

# 4. Create the R2 bucket
wrangler r2 bucket create txtshell-sync-storage

# 5. Deploy the Worker
wrangler deploy

# 6. Generate an auth secret and set it on the Worker
wrangler secret put AUTH_SECRET
# When prompted, paste the output of:  openssl rand -hex 32

# 7. Note the Worker URL printed by wrangler deploy — paste it into Txtshell
```

Optional: configure a custom domain via Cloudflare dashboard → Workers → txtshell-sync → Settings → Triggers → Custom Domains.

> **Why no `curl … | bash` one-liner?** Piping a remote script straight into a shell executes whatever the server returns, sight unseen — a poor pattern for a security-conscious tool. Path B's individual commands let you see each step and pinpoint any failure. Automate them yourself if you want; this project doesn't ship a script.

### Path C — Kavan's reference deployment

Same as Path B, with these specifics:

1. Worker name: `txtshell-sync`
2. R2 bucket `txtshell-sync-storage` **already exists** — skip step 4 (bucket create)
3. Auth secret generated with `openssl rand -hex 32`, stored in 1Password
4. Custom domain `sync.txtshell.com`, configured in the Cloudflare dashboard post-deploy
5. Run the full curl smoke test below before configuring the desktop client

## Post-deploy verification

After `wrangler deploy` and setting the secret, smoke-test before configuring any client. Save the token to an env var first so it stays out of shell history:

```bash
read -s TOKEN  # paste your token, press enter (won't echo)
export WORKER_URL="https://sync.txtshell.com"  # or your *.workers.dev URL
```

```bash
# 1. Unauthenticated request should be rejected
curl -i "$WORKER_URL/v1/blocks"
# Expect: 401 { "error": "unauthorized", ... }

# 2. Wrong-method request should be rejected
curl -i -X PATCH -H "Authorization: Bearer $TOKEN" "$WORKER_URL/v1/blocks"
# Expect: 405 { "error": "method-not-allowed", ... }

# 3. Authenticated GET on empty store
curl -i -H "Authorization: Bearer $TOKEN" "$WORKER_URL/v1/blocks"
# Expect: 404 { "error": "no-blob", ... }

# 4. Upload a small test blob
curl -i -X PUT -H "Authorization: Bearer $TOKEN" \
  --data-binary "test-blob-data" "$WORKER_URL/v1/blocks"
# Expect: 200 { "ok": true }

# 5. Download the test blob
curl -i -H "Authorization: Bearer $TOKEN" "$WORKER_URL/v1/blocks"
# Expect: 200 body "test-blob-data"

# 6. Inbox endpoints
curl -i -H "Authorization: Bearer $TOKEN" "$WORKER_URL/v1/inbox"
# Expect: 200 []

curl -i -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"test1","ciphertext":"fake","iv":"fake","createdAt":"2026-06-04T00:00:00Z"}' \
  "$WORKER_URL/v1/inbox"
# Expect: 200 { "id": "test1", "accepted": true }

# 7. Clean up the test blob
curl -i -X PUT -H "Authorization: Bearer $TOKEN" \
  --data-binary "" "$WORKER_URL/v1/blocks"
# Expect: 200 (overwrites the test data)

# 8. Clean up the test inbox entry
curl -i -X DELETE -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ids":["test1"]}' "$WORKER_URL/v1/inbox"
# Expect: 200 { "removed": 1, "remaining": 0 }
```

If a check fails:

- **401 where 200 expected** → auth secret mismatch (`wrangler secret list`)
- **404 where 200 expected** → R2 binding misconfigured (check `wrangler.toml`)
- **500** → check Cloudflare Workers logs
- **Connection refused** → custom domain/DNS not ready; try the `*.workers.dev` URL directly
- **400 `https-required` locally** → expected. The Worker rejects non-HTTPS; test against the deployed HTTPS URL, not `wrangler dev` over `http://localhost`.

## Threat model

**What the Worker protects against:**

- Random scanners spamming the Worker (auth token required)
- Network-level eavesdroppers (HTTPS-only)
- Cross-origin attacks from malicious websites (CORS origin allow-list)
- Replay via cached responses (`Cache-Control: no-store`)
- Cloudflare reading your content (data is encrypted client-side before upload)

**What the Worker does NOT protect against:**

- Compromise of your Cloudflare account (full control of the Worker)
- Compromise of your master key (decrypts all stored data — this lives on your client, not here)
- Compromise of the auth token (full Worker read/write/delete access)
- Cloudflare seeing request **metadata**: timestamps, source IP, request/response sizes, access patterns
- Cloudflare compelled disclosure of stored ciphertext (still encrypted, but they can hand it over if subpoenaed)

Cloudflare metadata exposure is an inherent tradeoff of using a hosted edge service, accepted in exchange for cheap hosting. For metadata privacy you'd use a VPN/Tor or self-host on infrastructure you fully control. The Worker code is portable to other edge platforms with minor changes.

## Operational runbooks

### Auth secret rotation (every 6–12 months, or on suspected compromise)

1. `openssl rand -hex 32` for a new secret
2. `wrangler secret put AUTH_SECRET --name txtshell-sync` and paste it — the old token is immediately invalid
3. Update desktop Txtshell with the new token
4. Re-pair iOS devices (fresh QR embeds the new token)
5. Verify with curl that the new token works and the old one is rejected

### Suspected auth token compromise

1. Rotate the secret immediately (above)
2. Review Cloudflare Workers analytics for unusual patterns in the exposure window
3. Check `inbox.json` for unexpected entries an attacker may have added
4. Drain any junk via `DELETE /v1/inbox`
5. If exposure is severe, consider master-key rotation (a significant client-side operation)

### Cloud blob corruption recovery

The desktop's IndexedDB is canonical; the cloud blob is a backup.

1. Force a re-upload from desktop (`/mirror push` or equivalent) — overwrites the corrupted blob
2. iOS re-fetches on next sync
3. If desktop also lacks the blocks (fresh reinstall): restore from an encrypted export file if available; otherwise the blocks may be unrecoverable

### Migrating between Cloudflare accounts

1. On the new account, follow Path B setup
2. Export current state: `wrangler r2 object get txtshell-sync-storage/users/<userid>/blocks.encrypted --file blocks.bak`
3. Import: `wrangler r2 object put txtshell-sync-storage/users/<userid>/blocks.encrypted --file blocks.bak`
4. Repeat for `inbox.json` if non-empty
5. Update desktop and iOS clients with the new URL and token

## Known limitations and accepted risks

- **No per-request rate limiting.** An attacker holding the auth token could burn through your Workers request quota. Cloudflare provides platform DDoS protection but not per-token rate limiting on the free tier. Mitigation: keep the token secret; rotate if abused; enable paid Rate Limiting if needed. Accepted for v1.
- **No automated tests.** The Worker is ~150 LOC across 5 endpoints; manual curl testing is sufficient for v1. Add tests if it grows.
- **No metadata privacy from Cloudflare.** See threat model. Inherent, not a bug.
- **Last-writer-wins.** Near-simultaneous `PUT /v1/blocks` from two devices: the second overwrites the first. No merge/conflict detection. Acceptable for single-user multi-device where concurrent editing is rare.
- **Single point of failure: Cloudflare.** During an outage the Worker is down; desktop and iOS continue with local data and queue sync for reconnect.
- **Master-key compromise is catastrophic.** If your master key is exfiltrated from any device, all uploaded ciphertext becomes decryptable. Recovery is full master-key rotation — intentionally a significant operation.

## Configuration reference

`wrangler.toml`:

```toml
name = "txtshell-sync"
main = "src/worker.ts"
compatibility_date = "2026-01-01"

[[r2_buckets]]
binding = "STORAGE"
bucket_name = "txtshell-sync-storage"
```

Environment binding (`src/worker.ts`):

```typescript
interface Env {
  STORAGE: R2Bucket;   // R2 bucket binding
  AUTH_SECRET: string; // set via: wrangler secret put AUTH_SECRET
}
```

Storage keys (with `USER_ID` hardcoded to `kavan` in v1):

- `users/${USER_ID}/blocks.encrypted` — the encrypted blocks blob
- `users/${USER_ID}/inbox.json` — the inbox array

The custom domain is **not** in `wrangler.toml`; configure it in the Cloudflare dashboard.

## License

TBD.
