#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pymupdf"]
# ///
"""Un-impose the scanned EBC-A40L user guide.

Input: `reference/EBC-A40L User Guide - Scan.pdf`
  - 12 landscape letter pages (792 x 612 pt)
  - Each PDF page = one physical sheet side from a saddle-stitched booklet
  - Each sheet side has two booklet pages side by side (left half | right half)

Output: `reference/EBC-A40L User Guide - split.pdf`
  - 24 portrait pages (396 x 612 pt)
  - In natural reading order: Front cover, Contents, pages 1..22

The mapping below was determined by reading the page numbers off the scan footers.
See `plans/scan-unimpose.md` for the full derivation.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Literal

import pymupdf  # type: ignore[import-not-found]

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SRC_PDF = PROJECT_ROOT / "reference" / "EBC-A40L User Guide - Scan.pdf"
DST_PDF = PROJECT_ROOT / "reference" / "EBC-A40L User Guide - split.pdf"

Side = Literal["L", "R"]

# Output order: list of (source_pdf_page_index, "L" or "R") for output pages 1..24.
# Derived from reading page-number footers off each half of the 12 scan pages.
OUTPUT_ORDER: list[tuple[int, Side]] = [
    (6, "R"),  # 1. Front cover
    (5, "L"),  # 2. Contents
    (7, "R"),  # 3. page 1
    (4, "L"),  # 4. page 2
    (8, "R"),  # 5. page 3
    (3, "L"),  # 6. page 4
    (9, "R"),  # 7. page 5
    (2, "L"),  # 8. page 6
    (10, "R"), # 9. page 7
    (1, "L"),  # 10. page 8
    (11, "R"), # 11. page 9
    (0, "L"),  # 12. page 10
    (0, "R"),  # 13. page 11
    (11, "L"), # 14. page 12
    (1, "R"),  # 15. page 13
    (10, "L"), # 16. page 14
    (2, "R"),  # 17. page 15
    (9, "L"),  # 18. page 16
    (3, "R"),  # 19. page 17
    (8, "L"),  # 20. page 18
    (4, "R"),  # 21. page 19
    (7, "L"),  # 22. page 20
    (5, "R"),  # 23. page 21
    (6, "L"),  # 24. page 22 (back of book)
]


def verify_order() -> None:
    """Sanity-check: every (pdf_page, side) pair must appear exactly once."""
    seen = set()
    for idx, side in OUTPUT_ORDER:
        key = (idx, side)
        assert key not in seen, f"duplicate in OUTPUT_ORDER: {key}"
        seen.add(key)
    assert len(seen) == 24, f"expected 24 halves, got {len(seen)}"


def main() -> int:
    verify_order()
    if not SRC_PDF.exists():
        print(f"missing: {SRC_PDF}", file=sys.stderr)
        return 1

    src = pymupdf.open(SRC_PDF)
    if len(src) != 12:
        print(f"warn: expected 12 pages, got {len(src)}", file=sys.stderr)

    dst = pymupdf.open()
    for out_idx, (src_idx, side) in enumerate(OUTPUT_ORDER, start=1):
        src_page = src[src_idx]
        w, h = src_page.rect.width, src_page.rect.height  # 792 x 612
        half_w = w / 2

        # New page is half the source width
        new_page = dst.new_page(width=half_w, height=h)

        if side == "L":
            clip = pymupdf.Rect(0, 0, half_w, h)
        else:
            clip = pymupdf.Rect(half_w, 0, w, h)

        # Place the clipped portion onto the new page at (0,0) to (half_w, h).
        new_page.show_pdf_page(
            pymupdf.Rect(0, 0, half_w, h),
            src,
            src_idx,
            clip=clip,
        )

    dst.save(DST_PDF, garbage=4, deflate=True)
    print(f"wrote {DST_PDF} ({len(dst)} pages)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
