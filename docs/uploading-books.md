# Uploading books to the Cloudflare R2 backend

This is the canonical spec for putting an audiobook into the
AudiobookReader R2 backend. Any tool — the reference
[`tools/upload-to-r2/upload-to-r2.py`](../tools/upload-to-r2/upload-to-r2.py)
script, a future second uploader, manual uploads via the R2 dashboard —
must follow it to produce a book that the web app can find and play.

## TL;DR

```
S3 PUT  <bucket>/<book-id>/playlist.m3u8       # HLS playlist (relative segment URLs)
S3 PUT  <bucket>/<book-id>/segments/000000.ts  # one per segment
S3 PUT  <bucket>/<book-id>/segments/000001.ts
…
S3 PUT  <bucket>/<book-id>/cover.jpg           # optional
S3 GET  <bucket>/index.json                    # fetch existing manifest
S3 PUT  <bucket>/index.json                    # append / replace book entry
```

The S3 API endpoint and credentials are R2's S3-compatible interface, NOT
the auth-worker. Uploads always go straight to R2.

After upload the book appears in the app the next time the R2 library is
refreshed (in-app refresh button, or page reload).

---

## Architecture in one paragraph

The web app, on first load of the R2 source, fetches `index.json` from
the bucket's base URL. That file lists every book — `id`, display
`name`, `format` (`hls` or `native`), pointer to the audio asset, and
optional metadata. When the user opens a book the app constructs absolute
URLs by joining the bucket base URL with the keys from `index.json`, and
HLS playback works from there (hls.js if needed, native otherwise). The
bucket base URL is either:

- `https://pub-<hash>.r2.dev` — public R2, no auth (fine for testing)
- `https://audiobookreader-r2.<account>.workers.dev` — the auth-worker
  proxy, which validates a Google access token before returning bytes

Uploaders do not interact with the worker. The worker only sits in front
of *reads*; writes always go via the S3 API.

---

## Bucket layout

The bucket name is configurable; the default is `audiobooks`.

```
audiobooks/
├── index.json                              ← manifest, ALWAYS at the root
├── <book-id-1>/
│   ├── playlist.m3u8                       ← required for format=hls
│   ├── segments/
│   │   ├── 000000.ts
│   │   ├── 000001.ts
│   │   └── …
│   ├── cover.jpg                           ← optional
│   └── metadata.json                       ← optional, not yet consumed
├── <book-id-2>/
│   ├── audiobook.m4a                       ← single file for format=native
│   └── cover.jpg
└── …
```

### Book ID conventions

- Lowercase, ASCII, `kebab-case` (`neurovelho`, `the-stoneheart`,
  `dune-part-1`).
- Stable forever — the book's progress key in the user's `localStorage`
  is `r2:<book-id>`, so renaming a book ID loses the user's listening
  position. If you must rename, also rename the prefix and update the
  manifest in one go (server-side `CopyObject` then delete; see
  ["Renaming a book"](#renaming-a-book) below).
- The ID is also the object key prefix — keep them in sync.

### Content-Type headers (must be set on upload)

R2 serves the `Content-Type` you set at upload time. The browser and
hls.js are picky about audio MIMEs, so set them correctly:

| Extension | Content-Type |
|-----------|--------------|
| `.m3u8`   | `application/vnd.apple.mpegurl` |
| `.ts`     | `video/mp2t` |
| `.m4a` / `.m4b` | `audio/mp4` |
| `.mp3`    | `audio/mpeg` |
| `.jpg` / `.jpeg` | `image/jpeg` |
| `.png`    | `image/png` |
| `.webp`   | `image/webp` |
| `.json`   | `application/json` |

`.ts` MUST be `video/mp2t` not `video/mp2ts` — hls.js refuses the latter.

---

## Manifest: `index.json`

A single JSON file at the bucket root. The web app fetches it with
`cache: 'no-cache'`, parses it, and renders the `books` array.

### Schema (v1)

```jsonc
{
  "version": 1,                              // integer, currently always 1
  "books": [                                 // array, may be empty
    {
      "id":       "neurovelho",              // required, must match prefix
      "name":     "Neurovelho",              // required, user-visible
      "format":   "hls",                     // required: "hls" | "native"

      // EXACTLY ONE of these two keys is required, depending on format:
      "playlist":  "neurovelho/playlist.m3u8",      // required when format=hls
      "audioFile": "another-book/audiobook.m4a",    // required when format=native

      "cover":     "neurovelho/cover.jpg",   // optional
      "duration":  36967.79,                 // optional, seconds (float)

      // any other keys are ignored by the app today but kept as you write
      // them — feel free to stash author, narrator, ISBN, etc.
      "author":    "Hannu Rajaniemi",
      "narrator":  "Anu Hynninen"
    }
  ]
}
```

### Update protocol

The manifest is mutable. Adding / removing books = upload a new
`index.json` that includes the change. There is **no append API** — you
fetch, edit, then put the whole file back.

Race conditions: R2 does not currently expose conditional writes on
`index.json`. If two uploaders update the manifest simultaneously, the
last writer wins. In practice book uploads are interactive so this is
fine; if you need to be safer, store a `version` integer and skip the
write if it changed under you (read again, retry).

### Validation

The web app validates only the basics: top-level is an object, `books`
is an array. Each book that lacks an `id` is dropped. Other fields are
trusted. Keep it well-formed (`json.dumps(..., indent=2)` is fine; the
file is small).

---

## HLS books

The most common case. A single multivariant `playlist.m3u8` (no
sub-playlists — audiobooks are mono-bitrate) plus N segment files.

### Generating a clean playlist

A playlist for upload must:

- Use **relative** segment URLs (`segments/000000.ts`) — never absolute
  URLs and never signed/expiring URLs. The browser resolves them against
  the playlist's own URL.
- Carry `#EXTINF:` durations from the source.
- End with `#EXT-X-ENDLIST` (this is a VOD playlist, not live).
- Optionally include `#EXT-X-PLAYLIST-TYPE:VOD`.
- Number segments contiguously from `000000.ts` to `<N-1>.ts` with the
  same six-digit zero-padded width.

Minimal valid playlist:

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-TARGETDURATION:11
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:9.914922,
segments/000000.ts
#EXTINF:10.007800,
segments/000001.ts
…
#EXT-X-ENDLIST
```

### Common mistakes

- Leaving absolute URLs from the source (will leak the source URL and
  hard-code an expiring token into the playlist).
- Missing `.ts` extension on the URL (some sources serve segments without
  extensions; rename or rewrite when uploading).
- Mismatched `#EXTINF:` count vs. number of segment lines.
- Forgetting `#EXT-X-ENDLIST` (player thinks it's a live stream and never
  seeks).
- Wrong `Content-Type` on the `.ts` upload (see table above).

### Reference: how `upload-to-r2.py` does it

The reference Python uploader parses the source playlist line-by-line,
captures `#EXTINF:` floats and segment numbers, then emits a fresh
playlist with `segments/000000.ts`-style relative URLs. See
`parse_source_playlist()` and `build_clean_playlist()` in
`tools/upload-to-r2/upload-to-r2.py`.

---

## Native (single-file) books

For audiobooks that aren't packaged as HLS — typical for non-DRM AAC,
MP3, or M4B files.

```
audiobooks/
└── dune-part-1/
    ├── audiobook.m4a       ← single file (any extension from the table)
    └── cover.jpg
```

Manifest entry:

```json
{
  "id": "dune-part-1",
  "name": "Dune, Part 1",
  "format": "native",
  "audioFile": "dune-part-1/audiobook.m4a",
  "cover": "dune-part-1/cover.jpg",
  "duration": 32400.0
}
```

The web app sets `<audio src="…">` directly. Byte-range seeking works
out of the box. No HLS / no hls.js loaded.

Caveat for the auth-worker setup: `<audio src=…>` can't carry an
`Authorization` header, so the app appends the user's Google access
token as a `?_token=…` query string. The worker accepts both forms.
Public R2 ignores the extra query param.

The reference upload script doesn't yet support native uploads — patches
welcome, but for now you can `aws s3 cp` (or boto3 `put_object`) the
file directly and then update `index.json` manually.

---

## S3 credentials & endpoint

The web app's `localStorage` and the auth-worker have **only the public
read URL** (`pub-*.r2.dev` or the worker URL). Uploading requires R2's
S3-compatible API, which uses an Access Key ID + Secret Access Key with
**Object Read & Write** permission on the bucket.

```env
R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<32-hex-char key>
R2_SECRET_ACCESS_KEY=<64-hex-char secret>
R2_BUCKET=audiobooks
R2_PUBLIC_BASE_URL=https://pub-<hash>.r2.dev          # for reference, not used during upload
```

Create the API token at:
**Cloudflare dashboard → R2 → Manage R2 API Tokens → Create API Token →
Object Read & Write, scoped to the bucket.**

The account ID is on the right sidebar of the R2 dashboard, and matches
the prefix of `R2_ENDPOINT`.

Keep `.env` out of git. The existing repo has a top-level `.gitignore`
that excludes `.env` patterns; verify in any new tool that `.env*` is
ignored.

### boto3 client init

```python
import boto3
s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["R2_ENDPOINT"],
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    region_name="auto",                 # R2 ignores this, but boto3 requires *something*
)
```

### Upload one object

```python
s3.upload_file(
    Filename=local_path,
    Bucket="audiobooks",
    Key="neurovelho/segments/000000.ts",
    ExtraArgs={"ContentType": "video/mp2t"},
)
```

### Parallel uploads

Use `ThreadPoolExecutor` with ~16-32 workers for segment uploads. R2
handles concurrency well. The reference script does this and gets
~65 segments/second (3697-segment book in ~57s).

Don't use multipart for files this small — segments are ~100 KB.
boto3's default 8 MB threshold for multipart is fine.

---

## Read security: the auth-worker is optional but recommended

If the bucket's `pub-*.r2.dev` URL is enabled, anyone with that URL can
download anything in the bucket. For a personal library that's usually
fine; if the content is copyrighted you want to gate reads:

- Deploy `tools/r2-auth-worker/` — Cloudflare Worker that requires a
  Google access token from an allowlisted email
- After deploy, disable the bucket's `pub-*.r2.dev` access (R2 dashboard
  → bucket → Settings → Public Access)
- The web app's R2 base URL is then the worker URL, not the R2 URL

This doesn't affect uploads at all — those continue to hit the S3 API
with admin credentials.

See `tools/r2-auth-worker/README.md` for deploy specifics.

---

## CORS

Only matters if you're serving the bucket directly (`pub-*.r2.dev`). The
auth-worker handles its own CORS.

If you use direct public access, the bucket's CORS policy must include
the app's origin (e.g. `http://localhost:8000`,
`https://anttir.github.io`) under `AllowedOrigins`, allow `GET` and
`HEAD`, and expose `Content-Length`, `Content-Range`, `Accept-Ranges`,
`ETag`. See `tools/upload-to-r2/cors.json`.

`Range` belongs in `AllowedHeaders` — without it hls.js byte-range
fetches break.

---

## Common operations

### Adding a book end-to-end

1. Pick `book-id` (kebab-case, lowercase ASCII).
2. Generate a clean playlist (relative segment URLs) from your source.
3. Upload `<book-id>/playlist.m3u8` with `Content-Type:
   application/vnd.apple.mpegurl`.
4. Upload every segment `<book-id>/segments/<NNNNNN>.ts` with
   `Content-Type: video/mp2t`. Numbering must match the playlist.
5. Upload optional `<book-id>/cover.jpg` (any image format from the
   table).
6. Fetch `index.json`, add (or replace, if updating) the book entry,
   upload it back with `Content-Type: application/json`.

### Renaming a book

A rename means changing the `id` (= prefix) and probably the `name`.
Best done as a server-side copy in R2 (free; no egress):

```python
# 1. CopyObject every <old-id>/* key to <new-id>/*
# 2. DeleteObjects on <old-id>/*
# 3. Edit index.json: change id + playlist/audioFile paths, leave name alone
#    if you only changed the prefix
# 4. Upload index.json
```

Users with progress on the old ID lose it (their `r2:<old-id>` entry no
longer matches a book). If that matters, also document a localStorage
migration.

### Removing a book

```python
# 1. DeleteObjects on <book-id>/*
# 2. Edit index.json: filter out the entry with that id
# 3. Upload index.json
```

### Listing books from a tool

The bucket has `index.json` for reads. Tools can read it either via:

- The public R2 URL: `https://pub-<hash>.r2.dev/index.json` (only if
  public access is on)
- The S3 API: `s3.get_object(Bucket=..., Key="index.json")` — always
  works regardless of public-access setting

### Bulk operations

R2 supports `DeleteObjects` (up to 1000 keys per call) and
`CopyObject`. Class A (writes) cost: 1 M ops/month free; Class B
(reads/listings): 10 M/month free. A 3700-segment book is ~3700 writes
on upload and ~3700 copies + 3700 deletes on rename, all within the
free tier.

---

## Reference implementations

- `tools/upload-to-r2/upload-to-r2.py` — Python uploader for HLS books.
  Run with `--book-id`, `--book-name`, `--source-playlist`,
  `--segments-dir`, optional `--cover`, optional `--workers N`.
- `tools/upload-to-r2/cors.json` — example CORS policy for the bucket
  (when not using the auth worker).
- `tools/r2-auth-worker/` — Cloudflare Worker that gates the bucket
  behind Google sign-in.

If you write a new uploader, follow the same conventions and the web
app will pick up your books without modification.
