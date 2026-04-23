#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pymupdf"]
# ///
"""Render just the footer band of each half-page, at high DPI, so page numbers are legible."""

from __future__ import annotations

import sys
from pathlib import Path

import pymupdf  # type: ignore[import-not-found]

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SRC_PDF = PROJECT_ROOT / "reference" / "EBC-A40L User Guide - Scan.pdf"
OUT_DIR = PROJECT_ROOT / "scripts" / "scan-unimpose" / "footers"


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(SRC_PDF)

    for i, page in enumerate(doc):
        w, h = page.rect.width, page.rect.height  # 792 x 612 landscape
        # Footer band = bottom ~15% of each half-page
        footer_top = h * 0.82
        for side, (x0, x1) in (("L", (0, w / 2)), ("R", (w / 2, w))):
            clip = pymupdf.Rect(x0, footer_top, x1, h)
            # 300 dpi for legible numbers
            pix = page.get_pixmap(
                matrix=pymupdf.Matrix(300 / 72, 300 / 72), clip=clip
            )
            pix.save(OUT_DIR / f"page_{i:02d}_{side}.png")
    print(f"wrote footers to {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
