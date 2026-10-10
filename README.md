# DisplayLink Previewer

See what a Colorado Time Systems DisplayLink scoreboard template looks like without opening
DisplayLink on the timing PC.

## Problem

DisplayLink stores scoreboard layouts as `.tpl` templates and `.seq` sequences. The files are
binary, only DisplayLink can open them, and DisplayLink runs on the Windows timing computer.
Reviewing or sharing a meet's boards means sitting at that machine.

## Features

- Opens a whole template library (folder picker or drag and drop) and shows every board in a gallery
- Large preview with optional LED-dot rendering, zoom, and PNG download
- Overlay templates (transparent backgrounds) shown over a checker or black backdrop
- Item inspector: position, text, font, colour, and the live data field each item is bound to
  (for example `SCBD_SW_TM[3]`, lane 3's time)
- "Show data fields" swaps placeholder text for field codes
- Sequences play in order with their real durations; slides are matched to files in the loaded folder
- Runs entirely in the browser: files are decoded locally and never uploaded
- WCAG AAA colour contrast, keyboard navigation (← → Esc)

## Quick Start

Locally, with a library preloaded:

```sh
python3 serve.py ~/Documents/"DisplayLink Library"/Templates
```

Or open `web/index.html` directly and use **Open folder**.

With Docker:

```sh
docker compose up -d          # http://localhost:8080
PORT=9000 docker compose up -d  # pick another port
```

Or without Compose:

```sh
docker build -t displaylink-previewer . && docker run --rm -p 8080:80 displaylink-previewer
```

## Self-hosting

The container is a static nginx site: the previewer runs entirely in the visitor's browser, so
there is no backend, database or upload storage to look after.

- Put it behind any reverse proxy for TLS (Caddy, Traefik, nginx…) pointing at port 80 of the
  container, or at the published host port.
- To attach it to an existing Docker network instead of publishing a port, add a
  `docker-compose.override.yml` (git-ignored, picked up automatically by `docker compose`):

  ```yaml
  services:
    displaylink-previewer:
      ports: !reset []
      networks: [proxy]
  networks:
    proxy:
      external: true
  ```

- The image sets a strict Content-Security-Policy; the only third-party request is Google Fonts.

## Architecture

```mermaid
flowchart LR
    F[".tpl / .seq files"] -->|File API| N["nrbf.js<br/>BinaryFormatter decoder"]
    N --> M["model.js<br/>templates, sequences, colours"]
    M --> R["render.js<br/>320×176 canvas"]
    R --> U["app.js<br/>gallery, inspector, playback"]
```

| Path | Purpose |
|---|---|
| `web/nrbf.js` | MS-NRBF (.NET BinaryFormatter) decoder; also loads in Node |
| `web/model.js` | Decoded objects → templates / sequences / library indexes; .NET `KnownColor` table |
| `web/render.js` | Draws a template at panel resolution; LED-dot upscaler |
| `web/app.js` | Gallery, detail view, inspector, sequence playback |
| `serve.py` | Local server (127.0.0.1 only) that can preload a library under `/library/` |
| `nrbf.py` | Python decoder: `python3 nrbf.py file.tpl` prints the file as JSON |
| `tools/parity.js` | Dumps files with the JS decoder for diffing against `nrbf.py` |
| `Dockerfile`, `docker/`, `docker-compose.yml` | Static nginx container |

## Details

### File format

- Files are .NET BinaryFormatter output from `Cts.DisplayLink.Graphics.Templates` 1.3.14.
- `Template`: `width`×`height` (320×176 for a 10 mm board), `Background` colour, optional
  `backgroundGraphic`, and `items` in paint order:
  - `TextTemplateItem`: static text, font, colours, alignment
  - `DataTextTemplateItem`: text bound to a live field via `SourceClass`, `Code` and `Index`
  - `GraphicTemplateItem`: an image embedded as PNG, plus its original path
  - `ShapeTemplateItem`: a filled/outlined rectangle
- Data text items keep their row height in `Height`; the inherited `height` is always 0.
- `GraphicSequence` (`.seq`): slides reference files by absolute Windows path; durations are
  .NET ticks (10,000,000 per second).
- `lib.cache` is DisplayLink's per-folder index (paths, dates, thumbnails for images and video).

### Rendering limits

- The `DisplayLink NxM` LED fonts aren't available, so a bold sans at M px stands in, thresholded
  to whole pixels. Line widths match the originals closely; glyph shapes don't exactly.
- Fonts that aren't installed (such as Knockout) fall back to similar fonts, squeezed to the
  `ActualWidth` DisplayLink recorded so text keeps its real footprint.
- Scrolling text is shown static; data fields show their design-time placeholder text.

### Performance

A 60-template library decodes and renders its gallery in about a second on a laptop; each
template is a few KB to a few hundred KB.

## License

Apache 2.0. Not affiliated with Colorado Time Systems; DisplayLink is their product.
