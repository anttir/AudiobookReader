#!/usr/bin/env python3
"""
Upload an HLS audiobook (playlist + segments) to a Cloudflare R2 bucket and
update the bucket's `index.json` manifest so the web app can list the new book.

The source playlist is parsed only for #EXTINF durations and segment numbering
— the absolute URLs in it (with expiring tokens) are intentionally discarded
and replaced by relative `segments/000000.ts` paths in the generated playlist.

Usage example:

    python upload-to-r2.py \\
        --book-id stoneheart \\
        --book-name "Stoneheart" \\
        --source-playlist /path/to/playlist.m3u8 \\
        --segments-dir   /path/to/segments \\
        --cover          /path/to/cover.jpg

Reads credentials from a `.env` file next to this script (see `.env.example`).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    import boto3                            # type: ignore
    from botocore.exceptions import ClientError   # type: ignore
except ImportError:
    sys.stderr.write("boto3 is required. Run: pip install -r requirements.txt\n")
    sys.exit(1)

try:
    from dotenv import load_dotenv          # type: ignore
except ImportError:
    sys.stderr.write("python-dotenv is required. Run: pip install -r requirements.txt\n")
    sys.exit(1)

try:
    from tqdm import tqdm                   # type: ignore
except ImportError:
    sys.stderr.write("tqdm is required. Run: pip install -r requirements.txt\n")
    sys.exit(1)


SCRIPT_DIR = Path(__file__).resolve().parent
SEGMENT_RE = re.compile(r"segments/(\d+)")
INDEX_OBJECT_KEY = "index.json"


# ---------- credentials -----------------------------------------------------

def load_credentials() -> dict:
    """Read R2 credentials from .env. Never log the secret values."""
    load_dotenv(SCRIPT_DIR / ".env")
    required = ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        sys.stderr.write(f"Missing env vars: {', '.join(missing)}. Copy .env.example to .env.\n")
        sys.exit(1)
    return {
        "endpoint":   os.environ["R2_ENDPOINT"],
        "access_key": os.environ["R2_ACCESS_KEY_ID"],
        "secret_key": os.environ["R2_SECRET_ACCESS_KEY"],
        "bucket":     os.environ["R2_BUCKET"],
        "public_url": os.environ.get("R2_PUBLIC_BASE_URL", ""),
    }


def make_s3_client(creds: dict):
    return boto3.client(
        "s3",
        endpoint_url=creds["endpoint"],
        aws_access_key_id=creds["access_key"],
        aws_secret_access_key=creds["secret_key"],
        region_name="auto",
    )


# ---------- playlist generation --------------------------------------------

def parse_source_playlist(path: Path) -> tuple[list[str], list[tuple[int, float]]]:
    """
    Returns (header_lines, segments) where each segment is (number, duration).
    Header lines exclude any segment-related directives.
    """
    header: list[str] = []
    segments: list[tuple[int, float]] = []
    pending_duration: float | None = None
    saw_first_extinf = False

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.rstrip()
        if not line:
            continue

        if line.startswith("#EXTINF:"):
            saw_first_extinf = True
            m = re.match(r"#EXTINF:([\d.]+)", line)
            pending_duration = float(m.group(1)) if m else 0.0
            continue

        if line.startswith("#EXT-X-ENDLIST"):
            break

        if line.startswith("#"):
            # Keep playlist-level headers but drop segment-level ones
            if not saw_first_extinf:
                header.append(line)
            continue

        # Segment URL line
        m = SEGMENT_RE.search(line)
        if not m or pending_duration is None:
            continue
        seg_num = int(m.group(1))
        segments.append((seg_num, pending_duration))
        pending_duration = None

    if not segments:
        raise RuntimeError(f"No segments parsed from {path}")
    return header, segments


def build_clean_playlist(header: list[str], segments: list[tuple[int, float]]) -> str:
    """Generate a playlist with relative segments/<n>.ts URLs."""
    lines: list[str] = []
    have_extm3u = any(h.startswith("#EXTM3U") for h in header)
    if not have_extm3u:
        lines.append("#EXTM3U")
    lines.extend(header)
    if not any(h.startswith("#EXT-X-PLAYLIST-TYPE") for h in header):
        lines.append("#EXT-X-PLAYLIST-TYPE:VOD")

    for seg_num, dur in segments:
        lines.append(f"#EXTINF:{dur:.6f},")
        lines.append(f"segments/{seg_num:06d}.ts")

    lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


def total_duration(segments: list[tuple[int, float]]) -> float:
    return sum(d for _, d in segments)


# ---------- upload ----------------------------------------------------------

CONTENT_TYPES = {
    ".m3u8": "application/vnd.apple.mpegurl",
    ".ts":   "video/mp2t",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png":  "image/png",
    ".webp": "image/webp",
    ".json": "application/json",
}


def content_type_for(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    return CONTENT_TYPES.get(ext, "application/octet-stream")


def upload_file(s3, bucket: str, local: Path, key: str) -> None:
    s3.upload_file(
        str(local),
        bucket,
        key,
        ExtraArgs={"ContentType": content_type_for(key)},
    )


def upload_bytes(s3, bucket: str, data: bytes, key: str, content_type: str) -> None:
    s3.put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)


def upload_segments_parallel(s3, bucket: str, prefix: str, segments_dir: Path,
                             segments: list[tuple[int, float]], workers: int = 16) -> None:
    """Upload all segments with a thread pool and a tqdm progress bar."""
    def _do(seg_num: int) -> int:
        local = segments_dir / f"{seg_num:06d}.ts"
        if not local.exists():
            raise FileNotFoundError(f"missing segment file: {local}")
        key = f"{prefix}/segments/{seg_num:06d}.ts"
        upload_file(s3, bucket, local, key)
        return seg_num

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_do, seg_num): seg_num for seg_num, _ in segments}
        with tqdm(total=len(futures), unit="seg", desc="segments") as bar:
            for fut in as_completed(futures):
                try:
                    fut.result()
                except Exception as e:
                    raise RuntimeError(f"segment {futures[fut]:06d} failed: {e}")
                bar.update(1)


# ---------- manifest --------------------------------------------------------

def fetch_manifest(s3, bucket: str) -> dict:
    try:
        resp = s3.get_object(Bucket=bucket, Key=INDEX_OBJECT_KEY)
        return json.loads(resp["Body"].read())
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return {"version": 1, "books": []}
        raise


def upsert_book(manifest: dict, entry: dict) -> dict:
    books = manifest.setdefault("books", [])
    for i, b in enumerate(books):
        if b.get("id") == entry["id"]:
            books[i] = entry
            return manifest
    books.append(entry)
    return manifest


# ---------- main ------------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--book-id", required=True, help="Identifier and bucket prefix (e.g. 'stoneheart')")
    p.add_argument("--book-name", required=True, help="Display name (e.g. 'Stoneheart')")
    p.add_argument("--source-playlist", required=True, type=Path)
    p.add_argument("--segments-dir", required=True, type=Path)
    p.add_argument("--cover", type=Path, default=None)
    p.add_argument("--workers", type=int, default=16, help="Parallel segment uploads")
    p.add_argument("--dry-run", action="store_true", help="Parse + plan but do not upload")
    args = p.parse_args()

    if not args.source_playlist.is_file():
        sys.stderr.write(f"Playlist not found: {args.source_playlist}\n")
        return 2
    if not args.segments_dir.is_dir():
        sys.stderr.write(f"Segments dir not found: {args.segments_dir}\n")
        return 2

    creds = load_credentials()
    header, segments = parse_source_playlist(args.source_playlist)
    print(f"Parsed {len(segments)} segments from {args.source_playlist.name}")
    print(f"Total duration: {total_duration(segments):.1f}s")

    clean_playlist = build_clean_playlist(header, segments)
    prefix = args.book_id.strip().strip("/")
    playlist_key = f"{prefix}/playlist.m3u8"

    if args.dry_run:
        print("--dry-run: skipping upload.")
        print(f"Would upload to bucket={creds['bucket']}, prefix={prefix}/")
        print(f"Generated playlist:\n{clean_playlist[:500]}{'...' if len(clean_playlist) > 500 else ''}")
        return 0

    s3 = make_s3_client(creds)

    print(f"Uploading segments to {creds['bucket']}/{prefix}/segments/ …")
    t0 = time.time()
    upload_segments_parallel(s3, creds["bucket"], prefix, args.segments_dir, segments, args.workers)
    print(f"Segment upload took {time.time() - t0:.1f}s")

    print("Uploading playlist …")
    upload_bytes(
        s3, creds["bucket"], clean_playlist.encode("utf-8"), playlist_key,
        content_type=CONTENT_TYPES[".m3u8"],
    )

    cover_key: str | None = None
    if args.cover:
        if not args.cover.is_file():
            print(f"warning: cover not found at {args.cover}, skipping")
        else:
            cover_key = f"{prefix}/cover{args.cover.suffix.lower()}"
            print(f"Uploading cover → {cover_key}")
            upload_file(s3, creds["bucket"], args.cover, cover_key)

    print("Updating index.json …")
    manifest = fetch_manifest(s3, creds["bucket"])
    entry = {
        "id": args.book_id,
        "name": args.book_name,
        "format": "hls",
        "playlist": playlist_key,
        "duration": round(total_duration(segments), 3),
    }
    if cover_key:
        entry["cover"] = cover_key
    manifest = upsert_book(manifest, entry)
    upload_bytes(
        s3, creds["bucket"], json.dumps(manifest, indent=2).encode("utf-8"),
        INDEX_OBJECT_KEY, content_type=CONTENT_TYPES[".json"],
    )

    print()
    print(f"Done. Book '{args.book_name}' is live at:")
    if creds["public_url"]:
        print(f"  {creds['public_url']}/{playlist_key}")
    else:
        print(f"  {creds['bucket']}/{playlist_key}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
