#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pymupdf"]
# ///
"""Render the output PDF's pages as thumbnails so I can verify the order is right."""

from __future__ import annotations

import sys
from pathlib import Path

import pymupdf  # type: ignore[import-not-found]

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DST_PDF = PROJECT_ROOT / "reference" / "EBC-A40L User Guide - split.pdf"
OUT_DIR = PROJECT_ROOT / "scripts" / "scan-unimpose" / "verify"


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(DST_PDF)
    print(f"pages: {len(doc)}")
    for i, page in enumerate(doc):
        r = page.rect
        print(f"out {i+1:02d}: {r.width:.1f} x {r.height:.1f} pt")
        pix = page.get_pixmap(matrix=pymupdf.Matrix(100 / 72, 100 / 72))
        pix.save(OUT_DIR / f"out_{i+1:02d}.png")
    print(f"wrote to {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
