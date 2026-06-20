# r2-auth-worker

Cloudflare Worker with two responsibilities, routed by path:

- **`/auth/*` — OAuth Authorization Code + PKCE backend.** The Worker holds
  the Google client secret, exchanges the auth code for an access + refresh
  token, and returns the browser an opaque **encrypted session token** (the
  refresh token is sealed inside it — stateless, no KV). The SPA stores it in
  localStorage and calls `POST /auth/token` to mint fresh Google access
  tokens. This replaces the GIS hidden-iframe silent refresh that iOS Safari
  ITP blocks, so logins survive on iPhone. See
  [`../../docs/auth-redesign.md`](../../docs/auth-redesign.md).
- **everything else — the R2 proxy.** The web app sends a Google OAuth access
  token as `Authorization: Bearer …` (or `?_token=`); the Worker verifies it
  against Google, checks the email against `ALLOWED_EMAILS`, and streams the
  requested R2 object (preserving `Range` so HLS keeps working).

## /auth endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/auth/login?return=<app-url>[&add=drive]` | GET | Redirect to Google consent (PKCE). `add=drive` requests the incremental Drive scopes. |
| `/auth/callback` | GET | Exchange code → seal session → redirect to `<app-url>#auth=<session>`. |
| `/auth/token` | POST | `Authorization: Bearer <session>` → `{ access_token, expires_in, scopes, email, name, picture }`. |
| `/auth/logout` | POST | Revoke the refresh token at Google. |

Requires the **`GOOGLE_CLIENT_SECRET`** secret (see wrangler.toml) and the
OAuth client must list `https://<worker>/auth/callback` as an Authorized
redirect URI.

After this is deployed the Worker URL replaces the `pub-*.r2.dev` URL in
the web app's R2 settings — so the bucket can be flipped to private
and the repo + Worker URL can stay public.

> **Currently deployed:** `https://audiobookreader-r2.audiobooks.workers.dev`.
> This is the URL hardcoded as `CONFIG.R2_DEFAULT_BASE_URL` in
> [`js/config.js`](../../js/config.js); the live app at
> [https://anttir.github.io/AudiobookReader/](https://anttir.github.io/AudiobookReader/)
> reads through this Worker. Public access on the `audiobooks` bucket is
> disabled — there is no fallback URL.

## How it talks to R2

The Worker is bound directly to the R2 bucket (`BUCKET` binding in
`wrangler.toml`). No S3 access keys, no token in the Worker. The S3
keys in `tools/upload-to-r2/.env` are still needed for uploading
content; nothing here.

## Token cache

Verified tokens are cached in `caches.default` for up to 5 minutes
(or the token's remaining lifetime, whichever is shorter). This keeps
playback from hammering Google's tokeninfo endpoint — a single 10 h
audiobook would otherwise cost ~3700 verifications.

## Deploy

```bash
cd tools/r2-auth-worker
npm install
npx wrangler login                  # browser opens; sign in with your CF account
npx wrangler deploy                 # builds + deploys
```

Output ends with the Worker URL, e.g.

```
https://audiobookreader-r2.<account-name>.workers.dev
```

Copy that URL.

## Wire up the web app

1. Open the app → Settings → Cloudflare R2 → paste the Worker URL into
   "Bucket public URL" (replacing the old `pub-*.r2.dev` URL).
2. Save. The R2Provider routes all fetches via the Worker; hls.js sends
   the Google access token with every segment request via `xhrSetup`.

## Lock down the bucket

Once the Worker is serving content, disable public access on the bucket
so the `pub-*.r2.dev` URL stops working:

- R2 dashboard → bucket → **Settings** → **Public access** → disable
  the `pub-*.r2.dev` URL.

The Worker still has access via its R2 binding; only direct public reads
are blocked.

## Edit allowlist later

Add or remove emails in `wrangler.toml` under `[vars] ALLOWED_EMAILS`,
then `npx wrangler deploy` again. Changes propagate in seconds.

## Local dev

```bash
npx wrangler dev
```

Spins the Worker up at `http://localhost:8787`. Useful for poking the
auth flow without redeploying. R2 binding works in dev too (reads the
real bucket via your wrangler login credentials).

## Cost

Workers free tier: 100 000 requests / day, 10 ms CPU / request. An HLS
playback uses ~1 request per ~10 s of audio. A 10 h book ≈ 3700
requests → well within the free tier.
