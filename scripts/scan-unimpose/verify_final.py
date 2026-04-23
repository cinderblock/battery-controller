#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pymupdf"]
# ///
"""Spot-check the final OCR'd PDF: render one page and check its dims."""

from __future__ import annotations

from pathlib import Path

import pymupdf  # type: ignore[import-not-found]

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DST_PDF = PROJECT_ROOT / "reference" / "EBC-A40L User Guide.pdf"
OUT_DIR = PROJECT_ROOT / "scripts" / "scan-unimpose" / "verify_final"


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(DST_PDF)
    print(f"pages: {len(doc)}")
    for i in (0, 1, 2, 11, 12, 23):  # front cover, contents, pg1, pg10, pg11, pg22
        page = doc[i]
        print(f"out {i+1:02d}: {page.rect.width:.1f} x {page.rect.height:.1f} pt")
        pix = page.get_pixmap(matrix=pymupdf.Matrix(100 / 72, 100 / 72))
        pix.save(OUT_DIR / f"final_{i+1:02d}.png")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
