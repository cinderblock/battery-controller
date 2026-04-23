# EBC-A40L User Guide Scan — Unimposition & OCR

## Goal

Convert `reference/EBC-A40L User Guide - Scan.pdf` (12 pages, each containing two side-by-side booklet pages) into a 24-page PDF with pages in correct 1..24 order, then OCR it.

## Source file

`C:/Users/camer/git/Personal Projects/battery-controller/reference/EBC-A40L User Guide - Scan.pdf`
- 12 PDF pages, 4,076,811 bytes
- Each page = one physical sheet side (6 sheets × 2 sides)
- Each sheet side contains 2 booklet pages, left and right
- Pages are already correctly oriented (user confirmed)

## Background — how a 24-page saddle-stitched booklet is imposed

For a booklet of 24 pages made from 6 sheets, folded and stapled down the middle, the imposition is:

| Sheet | Outer (front) | Inner (back) |
|-------|---------------|--------------|
| 1 | 24 \| 1 | 2 \| 23 |
| 2 | 22 \| 3 | 4 \| 21 |
| 3 | 20 \| 5 | 6 \| 19 |
| 4 | 18 \| 7 | 8 \| 17 |
| 5 | 16 \| 9 | 10 \| 15 |
| 6 | 14 \| 11 | 12 \| 13 |

The rule: outer sheet carries (1, last), next carries (3, last-2) etc. Left side of front has the higher number; right side has the lower number. Back side is swapped.

But the *actual* order in the scan depends on:
- Which sheet went through the scanner first (outer first vs inner first)
- Whether front or back of each sheet was scanned first
- Whether pages were flipped between scans (affecting left/right order)

## Plan / steps

1. [x] Locate PDF — `reference/EBC-A40L User Guide - Scan.pdf`
2. [x] Render low-res thumbnails of all 12 PDF pages
3. [x] Build (pdf_page_index, side) → booklet_page_number mapping by reading footers
4. [x] Write Python split/reorder script (`scripts/scan-unimpose/unimpose.py`) using pymupdf's `show_pdf_page` with a clip rect — produces actually-half-sized output pages (vector-preserving; no raster re-encoding).
5. [x] Install Tesseract 5.5 via winget (machine-wide, `C:\Program Files\Tesseract-OCR\`).
6. [x] OCR via Tesseract directly, no ocrmypdf needed — Tesseract supports multi-image input via a list file and emits a searchable multi-page PDF. Script: `scripts/scan-unimpose/ocr.py`.
7. [x] Compress: feed Tesseract JPEG-quality-85 intermediates instead of PNG. Tesseract preserves the input image format verbatim in the output, so JPEG input → JPEG in PDF → 6.6 MB vs 27 MB for PNG.

## Decisions already made

- **Orientation is fine** — user confirmed. No rotation needed.
- **Output location** — next to original in `reference/`.
- **Keep original scan file** — do not delete.

## Findings / gotchas

### Booklet structure (determined from thumbnails)

**22 numbered content pages + 1 unnumbered "Contents" page + 1 unnumbered Front Cover = 24 booklet pages on 6 physical sheets.**

Saddle-stitched; content pairs sum to 21 (pages 1&20 face each other around 5 content sheets):

- Sheet 1 (cover, outermost): outside = [pg 22 | Front Cover], inside = [Contents | pg 21]
- Sheet 2: outside = [pg 20 | pg 1], inside = [pg 2 | pg 19]
- Sheet 3: outside = [pg 18 | pg 3], inside = [pg 4 | pg 17]
- Sheet 4: outside = [pg 16 | pg 5], inside = [pg 6 | pg 15]
- Sheet 5: outside = [pg 14 | pg 7], inside = [pg 8 | pg 13]
- Sheet 6 (innermost): outside = [pg 12 | pg 9], inside = [pg 10 | pg 11]

### Scanner picked up sheets from innermost to outermost-cover

Actual PDF page index → booklet content (L | R):

| PDF idx | L half | R half |
|---------|--------|--------|
| 0       | pg 10  | pg 11  |
| 1       | pg 8   | pg 13  |
| 2       | pg 6   | pg 15  |
| 3       | pg 4   | pg 17  |
| 4       | pg 2   | pg 19  |
| 5       | Contents | pg 21 |
| 6       | pg 22  | Front Cover |
| 7       | pg 20  | pg 1   |
| 8       | pg 18  | pg 3   |
| 9       | pg 16  | pg 5   |
| 10      | pg 14  | pg 7   |
| 11      | pg 12  | pg 9   |

### Output order (24 pages)

| Out # | From PDF idx, side | What it is |
|-------|-------------------|------------|
| 1     | 6R                | Front cover |
| 2     | 5L                | Contents |
| 3..22 | derived           | Pages 1..20 |
| 23    | 5R                | Page 21 |
| 24    | 6L                | Page 22 (back of book) |

### Page dimensions

- Each scanned PDF page: 792 × 612 pt (landscape US Letter at 72 dpi)
- Split line: x = 396 pt (exact midpoint)
- Output pages will be 396 × 612 pt (portrait ~5.5" × 8.5")

## Tools available on this machine

- Python 3.12 / Python 3.11
- uv (preferred for Python dep management per CLAUDE.md)
- pdftotext (from MSYS2)
- No tesseract, ocrmypdf, pdfinfo on PATH — install via uv / winget if needed

## Outputs

- `reference/EBC-A40L User Guide - Scan.pdf` — original scan (kept intact)
- `reference/EBC-A40L User Guide - split.pdf` — 24 pages in correct order, no OCR (4.1 MB, vector-preserved from original scan)
- `reference/EBC-A40L User Guide.pdf` — 24 pages, OCR'd searchable (6.6 MB)

Scripts in `scripts/scan-unimpose/`:
- `render_thumbnails.py` — low-res page thumbnails for visual inspection
- `render_footers.py` — 300 DPI footer crops, used to read page numbers
- `render_halves.py` — renders each half-page separately
- `unimpose.py` — the actual split + reorder
- `ocr.py` — renders to JPEG then calls Tesseract to make searchable PDF
- `verify.py`, `verify_final.py` — spot-check scripts

## OCR caveats

- Body text OCR'd cleanly (10pt+ printed English).
- Table-of-contents dotted leaders (`....`) OCR'd as noise. The chapter titles themselves are fine.
- Chinese characters on the front cover (`灼智` = "Zhuo Zhi" brand name) not recognized — would need `chi_sim` tessdata. Cosmetic only; English content is complete.
- Copyright `©` symbol came out as `�` (replacement char). Also cosmetic.

## Things not to do

- Don't destroy the original scan.
- Don't guess the imposition order without looking at thumbnails first — scanner order varies.
- Don't feed Tesseract lossless PNG if file size matters — it embeds the raw input bytes into the output PDF.
- Don't name a Python script `inspect.py` — it shadows the stdlib `inspect` module and breaks any library that uses `inspect.signature`.
