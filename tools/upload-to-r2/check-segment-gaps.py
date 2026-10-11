#!/usr/bin/env python3
"""
Check an HLS audiobook's .ts segments for dropouts at segment boundaries.

Segments cut from one continuous encode join seamlessly. Segments encoded one
at a time each start with encoder priming, which decodes as ~20-50 ms of
near-silence at every boundary: a tiny gap every ~10 s, and with USB-C DACs
that auto-mute on silence (Apple EarPods USB-C on Android) a fade-in each time.

Decodes pairs of consecutive segments as one stream (decoder state carries
over, as in the player) and compares the quietest 2.5 ms at each boundary with
the quietest 2.5 ms just before it. Pauses in speech land on boundaries no
more often than anywhere else, so the median over many boundaries is ~0 dB
for seamless joins and strongly negative when every boundary has a hole.

Usage:

    python check-segment-gaps.py --segments-dir /path/to/segments [--samples 30]

Needs ffmpeg on PATH. Standard library only.
"""

from __future__ import annotations

import argparse
import array
import math
import re
import statistics
import subprocess
import sys
from pathlib import Path

RATE = 44100
WIN = int(RATE * 0.0025)         # 2.5 ms level windows
AT = (-0.010, 0.060)             # where a priming hole sits, around the boundary (s)
BEFORE = (-0.140, -0.070)        # same-length control just before it
# Median (boundary - control) this far negative means dropouts. Seamless
# joins measure about 0 dB: speech doesn't care where a segment ends.
GAP_DB = -10.0


def decode(inputs: list[Path]) -> array.array:
    """Decode the files as one byte stream to mono float32 at RATE."""
    # Bare names + cwd: a Windows drive letter would read as a protocol.
    src = "concat:" + "|".join(p.name for p in inputs)
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", src,
         "-ac", "1", "-ar", str(RATE), "-f", "f32le", "-"],
        check=True, capture_output=True, cwd=inputs[0].parent).stdout
    pcm = array.array("f")
    pcm.frombytes(out)
    return pcm


def quietest_dbfs(pcm: array.array, at: int, span: tuple[float, float]) -> float:
    """Level (dBFS) of the quietest window in `span` seconds around `at`."""
    lo, hi = at + int(span[0] * RATE), at + int(span[1] * RATE)
    q = min(math.sqrt(sum(x * x for x in pcm[i:i + WIN]) / WIN)
            for i in range(lo, hi - WIN + 1, WIN // 2))
    return 20 * math.log10(max(q, 1e-9))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--segments-dir", required=True, type=Path)
    p.add_argument("--samples", type=int, default=30,
                   help="Boundaries to check, spread over the book")
    args = p.parse_args()

    segs = sorted(args.segments_dir.glob("*.ts"),
                  key=lambda f: int(re.sub(r"\D", "", f.stem) or 0))
    if len(segs) < 3:
        sys.stderr.write(f"Need at least 3 .ts files in {args.segments_dir}\n")
        return 2

    step = max(1, (len(segs) - 2) // args.samples)
    picks = list(range(1, len(segs) - 1, step))[:args.samples]
    diffs = []
    for i in picks:
        at = len(decode([segs[i]]))              # boundary = end of segs[i]
        pcm = decode([segs[i], segs[i + 1]])
        if at < int(-BEFORE[0] * RATE) or at + int(AT[1] * RATE) > len(pcm):
            continue                             # too short to measure
        b, c = quietest_dbfs(pcm, at, AT), quietest_dbfs(pcm, at, BEFORE)
        if c > -90:                              # skip digital-silence passages
            diffs.append(b - c)
        print(f"{segs[i].name} | {segs[i + 1].name}: boundary {b:6.1f} dBFS, "
              f"just before {c:6.1f} dBFS")

    if not diffs:
        print("No measurable boundaries (silent audio?).")
        return 2
    median = statistics.median(diffs)
    print(f"\nBoundary vs just before (median of {len(diffs)}): {median:+.1f} dB")
    if median <= GAP_DB:
        print("DROPOUTS at segment boundaries — the segments were encoded "
              "separately; re-encode as one continuous stream.")
        return 1
    print("OK: segments join seamlessly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
