#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pymupdf"]
# ///
"""Render each HALF-page at low DPI so we can see full content to identify each half."""

from __future__ import annotations

import sys
from pathlib import Path

import pymupdf  # type: ignore[import-not-found]

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SRC_PDF = PROJECT_ROOT / "reference" / "EBC-A40L User Guide - Scan.pdf"
OUT_DIR = PROJECT_ROOT / "scripts" / "scan-unimpose" / "halves"


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(SRC_PDF)

    for i, page in enumerate(doc):
        w, h = page.rect.width, page.rect.height
        for side, (x0, x1) in (("L", (0, w / 2)), ("R", (w / 2, w))):
            clip = pymupdf.Rect(x0, 0, x1, h)
            pix = page.get_pixmap(matrix=pymupdf.Matrix(100 / 72, 100 / 72), clip=clip)
            pix.save(OUT_DIR / f"page_{i:02d}_{side}.png")
    print(f"wrote halves to {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
