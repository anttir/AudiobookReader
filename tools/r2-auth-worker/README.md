# r2-auth-worker

Cloudflare Worker that gates the private R2 bucket behind Google Sign-In.
The web app sends its Google OAuth access token as
`Authorization: Bearer …`; the Worker verifies the token against Google,
checks the resolved email against `ALLOWED_EMAILS`, and streams the
requested R2 object back to the client (preserving `Range` headers so
HLS keeps working).

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
