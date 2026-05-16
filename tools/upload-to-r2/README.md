# upload-to-r2

Reference implementation of an HLS audiobook uploader for the
AudiobookReader R2 backend. Uploads playlist + .ts segments + optional
cover, then updates the bucket's `index.json` manifest so the web app
picks up the new book.

> **Writing your own uploader?** Read
> [`docs/uploading-books.md`](../../docs/uploading-books.md) first — it
> documents the bucket layout, manifest schema, content-types,
> conventions and gotchas that any uploader (this script, a future
> alternative, or a manual flow) must follow.

## One-time R2 setup

### 1. Create an R2 bucket

1. Sign in at <https://dash.cloudflare.com> → **R2**.
2. **Create bucket** → name it `audiobooks` (or anything else; the name lives
   in the `R2_BUCKET` env var).
3. Open the bucket → **Settings**.
4. **Public Access** → enable `pub-*.r2.dev` (gives a public read URL like
   `https://pub-<hash>.r2.dev`). You can also configure a custom domain — both
   work with the app.
5. Copy the **Public R2.dev Bucket URL** — that's the value you paste into
   the app's R2 settings.

### 2. Configure CORS

In the bucket settings → **CORS Policy**, paste the contents of
[`cors.json`](cors.json). Adjust `AllowedOrigins` for your deployment:

- `http://localhost:8000` / `http://127.0.0.1:8000` — local dev server
- `https://<username>.github.io` — GitHub Pages
- any custom domain you serve the app from

Without CORS the browser will refuse to fetch the playlist + segments and
hls.js will fail with a network error.

### 3. Create an API token

1. R2 dashboard → **Manage R2 API Tokens** → **Create API Token**.
2. Permissions: **Object Read & Write** scoped to your bucket.
3. Save the Access Key ID + Secret Access Key — they appear once.

### 4. Hostname for the script

Cloudflare R2's S3-compatible endpoint is:

```
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

Your Account ID is on the R2 dashboard's right-hand sidebar.

## Pricing (for context)

R2 free tier:

- **10 GB** stored
- **1 M** Class A operations / month (writes)
- **10 M** Class B operations / month (reads)
- **0 €** egress (no per-byte data transfer charge)

Past the free tier: $0.015 / GB / month, still no egress. A typical HLS
audiobook is ~250 MB, so the free tier holds ~40 books comfortably.

## Install + configure the script

```bash
cd tools/upload-to-r2
python -m venv venv
venv\Scripts\activate          # Windows PowerShell
# or: source venv/bin/activate  # Linux/Mac
pip install -r requirements.txt

cp .env.example .env
# Edit .env: fill R2_ENDPOINT, keys, bucket name, public URL
```

`.env` is git-ignored — credentials never leave your machine.

## Upload a book

```bash
python upload-to-r2.py \
    --book-id stoneheart \
    --book-name "Stoneheart" \
    --source-playlist /path/to/playlist.m3u8 \
    --segments-dir   /path/to/segments \
    --cover          /path/to/cover.jpg
```

What the script does:

1. **Parses** the source playlist for `#EXTINF` durations and segment numbers.
   Absolute URLs in the source (e.g. signed Akamai links) are ignored.
2. **Generates** a clean `playlist.m3u8` with relative `segments/000000.ts`
   URLs that the app/hls.js can resolve against R2.
3. **Uploads** all `.ts` segments under `<book-id>/segments/`, then the
   playlist, then the cover image (if provided), with up to 16 parallel
   uploads.
4. **Updates** `index.json` at the bucket root — fetches the existing one,
   adds/replaces this book's entry, uploads it back.

After the run, the book shows up in the app the next time you load the R2
library (and the in-app "Päivitä" / refresh button).

## Resulting bucket layout

```
audiobooks/
  index.json
  stoneheart/
    playlist.m3u8
    cover.jpg
    segments/
      000000.ts
      000001.ts
      …
      003696.ts
```

## index.json shape

```json
{
  "version": 1,
  "books": [
    {
      "id": "stoneheart",
      "name": "Stoneheart",
      "format": "hls",
      "playlist": "stoneheart/playlist.m3u8",
      "cover": "stoneheart/cover.jpg",
      "duration": 36854.2
    }
  ]
}
```

Native (non-HLS) books — for single-file audiobooks — use `"format": "native"`
and `"audioFile": "another-book/audiobook.m4a"` instead of `playlist`. The web
app supports both shapes; the script currently only writes HLS entries.

## Removing a book

R2 doesn't ship a CLI for object removal, but you can do it from the dashboard
or with `aws s3 rm s3://<bucket>/<prefix>/ --recursive --endpoint-url=…`.
Afterwards, edit `index.json` to drop the entry (or upload a new manifest).
