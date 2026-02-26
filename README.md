# PageGobbler

A Chrome extension that gobbles up entire web pages — full-page screenshots with smart compression, section splitting, OCR text extraction, and page context metadata. Built for feeding screenshots to AI agents under file size constraints.

## Features

- **Full-page scroll-and-stitch capture** — scrolls through the entire page, capturing each viewport and stitching into a single image
- **Smart compression** — iterative format/quality/scale reduction to hit a target file size (default 3 MB)
- **Smart section splitting** — breaks tall pages at natural visual boundaries (whitespace rows) into multiple images
- **OCR text extraction** — optional Tesseract.js-powered text recognition from the captured image
- **DOM text fallback** — extracts visible text content directly from the page DOM when OCR is unavailable
- **Page metadata** — collects URL, title, headings, meta tags, links, dimensions, and timestamps
- **Viewer page** — dedicated results page with image preview, download controls, OCR text, and metadata tabs
- **Download all** — batch download all sections + metadata JSON + OCR text file

## What It Captures

For each screenshot, PageGobbler produces:

| Output | Description |
|--------|-------------|
| Image section(s) | Compressed WebP/JPEG/PNG, each under your size target |
| `_metadata.json` | Page URL, title, headings, meta tags, dimensions, compression stats |
| `_ocr.txt` | Extracted text (OCR or DOM-based) |

## Install (Developer Mode)

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked**
5. Select the repo folder
6. The turkey icon appears in your toolbar

## Usage

1. Navigate to any webpage
2. Click the turkey icon in the toolbar
3. (Optional) Expand **Settings** to configure:
   - **Max File Size** — target per-section limit (default 3 MB)
   - **Compression** — Auto (WebP then JPEG), Aggressive, or Lossless (PNG)
   - **Section Max Height** — pixel height before splitting (default 4096)
   - **OCR** — enable/disable Tesseract.js text extraction
   - **Smart Sections** — enable/disable automatic splitting
   - **Quality** — base quality slider (0.30 - 1.00)
4. Click **Gobble This Page**
5. The viewer page opens automatically with results

## Architecture

```
manifest.json (Manifest V3)
|
+-- background.js          -- Service worker: capture orchestration, rate limiting
+-- content/content.js     -- Injected into pages: scrolling, measurement, metadata
+-- lib/
|   +-- image-processor.js -- Canvas stitching, compression, smart sectioning
|   +-- ocr-engine.js      -- Tesseract.js wrapper + DOM text fallback
+-- popup/
|   +-- popup.html/css/js  -- Extension popup with capture button + settings
+-- viewer/
|   +-- viewer.html/css/js -- Results page: image preview, OCR, metadata, downloads
+-- icons/
    +-- icon{16,48,128}.png
    +-- generate-icons.html -- Open in browser to create branded icons
```

## Limitations

- Cannot capture `chrome://` or other extension pages
- Chrome's canvas max size is ~32,767 x 32,767 px (very tall pages may hit this)
- `captureVisibleTab` is limited to 2 calls/second — a 20-viewport page takes ~10 seconds minimum
- OCR requires loading Tesseract.js (~15 MB) from CDN on first use
- Lazy-loaded content may not be fully rendered if it requires user interaction beyond scrolling

## Settings Storage

All settings persist in `chrome.storage.local`. Default values:

```json
{
  "format": "png",
  "quality": 0.92,
  "maxFileSizeMB": 3,
  "enableOCR": true,
  "enableSections": true,
  "sectionMaxHeight": 4096,
  "compressionStrategy": "auto"
}
```
