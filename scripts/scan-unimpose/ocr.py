#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pymupdf"]
# ///
"""Render split PDF pages to images, run Tesseract to produce a searchable PDF.

Tesseract can natively produce a multi-page searchable PDF by reading a text file
that lists input image paths. That sidesteps the need for Ghostscript or ocrmypdf.

Output: `reference/EBC-A40L User Guide.pdf`
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

import pymupdf  # type: ignore[import-not-found]

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SRC_PDF = PROJECT_ROOT / "reference" / "EBC-A40L User Guide - split.pdf"
DST_PDF = PROJECT_ROOT / "reference" / "EBC-A40L User Guide.pdf"
TESSERACT = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")

DPI = 300  # Render resolution before OCR. Tesseract likes 300 DPI.


def main() -> int:
    if not TESSERACT.exists():
        print(f"missing: {TESSERACT}", file=sys.stderr)
        return 1
    if not SRC_PDF.exists():
        print(f"missing: {SRC_PDF}", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="a40l-ocr-") as tmp:
        tmp_path = Path(tmp)

        # 1. Render each PDF page to a TIFF
        doc = pymupdf.open(SRC_PDF)
        image_paths: list[Path] = []
        zoom = DPI / 72
        for i, page in enumerate(doc):
            pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
            # JPEG keeps the output PDF small: tesseract embeds the input
            # image format verbatim, so PNG → ~27 MB, JPEG @ q85 → ~4 MB.
            # Quality 85 is plenty for 10-pt+ printed text.
            img_path = tmp_path / f"page_{i+1:02d}.jpg"
            img_path.write_bytes(pix.tobytes("jpg", jpg_quality=85))
            image_paths.append(img_path)
            print(f"rendered page {i+1}/{len(doc)}")
        doc.close()

        # 2. Create a list file for tesseract
        list_file = tmp_path / "pages.txt"
        list_file.write_text("\n".join(str(p) for p in image_paths), encoding="utf-8")

        # 3. Run tesseract to produce a searchable PDF
        # `tesseract <list.txt> <output_stem> pdf` produces <output_stem>.pdf
        output_stem = tmp_path / "output"
        cmd = [
            str(TESSERACT),
            str(list_file),
            str(output_stem),
            "-l", "eng",
            "--dpi", str(DPI),
            "pdf",
        ]
        print("running:", " ".join(cmd))
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            print("tesseract stderr:", result.stderr, file=sys.stderr)
            print("tesseract stdout:", result.stdout, file=sys.stderr)
            return result.returncode
        print("tesseract stdout:", result.stdout[:500])
        if result.stderr:
            # Tesseract prints progress info to stderr — not an error
            print("tesseract stderr:", result.stderr[:500])

        # 4. Move the output PDF to final location
        tess_output = output_stem.with_suffix(".pdf")
        if not tess_output.exists():
            print(f"tesseract did not produce {tess_output}", file=sys.stderr)
            return 1
        DST_PDF.write_bytes(tess_output.read_bytes())
        print(f"wrote {DST_PDF} ({DST_PDF.stat().st_size:,} bytes)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
