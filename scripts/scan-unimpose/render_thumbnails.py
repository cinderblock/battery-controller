#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pymupdf"]
# ///
"""Render each scanned PDF page to a PNG thumbnail so we can identify booklet page numbers.

Also prints page dimensions so we know where to split.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pymupdf  # type: ignore[import-not-found]

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SRC_PDF = PROJECT_ROOT / "reference" / "EBC-A40L User Guide - Scan.pdf"
OUT_DIR = PROJECT_ROOT / "scripts" / "scan-unimpose" / "thumbnails"


def main() -> int:
    if not SRC_PDF.exists():
        print(f"missing: {SRC_PDF}", file=sys.stderr)
        return 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    doc = pymupdf.open(SRC_PDF)
    print(f"pages: {len(doc)}")
    for i, page in enumerate(doc):
        r = page.rect
        print(f"page {i:02d}: {r.width:.1f} x {r.height:.1f} pt (rotation={page.rotation})")
        # ~120 dpi is plenty for identifying content
        pix = page.get_pixmap(matrix=pymupdf.Matrix(120 / 72, 120 / 72))
        pix.save(OUT_DIR / f"page_{i:02d}.png")

    print(f"wrote thumbnails to {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
