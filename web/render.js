// Draws a template model onto a canvas at native panel resolution, plus the
// LED-dot upscaler used for the large preview.
(function (root) {
  'use strict';

  // "DisplayLink 11x13" style LED fonts are N px wide x M px tall cells (M includes
  // descenders). We stand them in with a bold sans at M px, which matches the real
  // line widths, then threshold the anti-aliasing away so glyphs land on whole pixels.
  const LED_FONT = /^DisplayLink (\d+)x(\d+)$/;
  const LED_FAMILY = '"Arial", "Helvetica Neue", Helvetica, sans-serif';
  const FALLBACKS = {
    knockout: '"Knockout 71 Full Middlewt", "Oswald", "Arial Narrow", "Impact", sans-serif',
  };

  function fontSpec(it) {
    const m = LED_FONT.exec(it.fontName);
    if (m) {
      const h = +m[2];
      return { led: true, px: h, lineHeight: h + 1, family: LED_FAMILY, weight: 'bold', ascent: Math.round(h * 0.78) };
    }
    const px = Math.round(it.fontSize * 96 / 72); // .NET font sizes are points
    const family = /knockout/i.test(it.fontName)
      ? `"${it.fontName}", ${FALLBACKS.knockout}`
      : `"${it.fontName}", sans-serif`;
    return { led: false, px, lineHeight: Math.round(px * 1.15), family, weight: it.bold ? 'bold' : 'normal', ascent: Math.round(px * 0.8) };
  }

  const imageCache = new WeakMap();
  function decodeImage(bytes) {
    if (!bytes) return Promise.resolve(null);
    if (!imageCache.has(bytes)) {
      imageCache.set(bytes, createImageBitmap(new Blob([bytes])).catch(() => null));
    }
    return imageCache.get(bytes);
  }

  // Render text for one item onto its own native-res canvas, then copy it in.
  function drawText(ctx, it, opts) {
    let text = it.text;
    if (opts.showCodes && it.type === 'DataText') text = `${it.code}${it.index > 1 || /\d$/.test(it.text) ? '·' + it.index : ''}`;
    if (!text) return;
    const fs = fontSpec(it);
    const lines = text.replace(/\r\n/g, '\n').split('\n');

    const { w, h } = itemBox(it);
    if (w <= 0 || h <= 0) return;
    const pad = 2;
    const c = new OffscreenCanvas(w + pad * 2, h + pad * 2);
    const g = c.getContext('2d');
    g.font = `${it.italic ? 'italic ' : ''}${fs.weight} ${fs.px}px ${fs.family}`;
    g.textBaseline = 'alphabetic';
    
    const block = lines.length * fs.lineHeight;
    const boxH = h;
    let y0 = it.vAlign === 'top' ? 0 : it.vAlign === 'bottom' ? boxH - block : (boxH - block) / 2;
    const fill = (it.dim ? it.dimColor : it.color) || { css: '#fff' };

    // ActualWidth is DisplayLink's own measurement of the widest line. When our
    // stand-in font runs wider (fonts not installed here), squeeze to match.
    const widths = lines.map(l => g.measureText(l).width);
    const widest = Math.max(...widths, 1);
    const limit = it.actualWidth > 0 && !(opts.showCodes && it.type === 'DataText') ? it.actualWidth : w;
    const squeeze = Math.min(1, limit / widest);

    g.fillStyle = fill.css;
    lines.forEach((line, i) => {
      const tw = widths[i] * squeeze;
      const x = Math.round(it.hAlign === 'left' ? 0 : it.hAlign === 'right' ? w - tw : (w - tw) / 2) + pad;
      const base = Math.round(y0 + i * fs.lineHeight + fs.ascent) + pad;
      g.save();
      g.translate(x, base);
      g.scale(squeeze, 1);
      g.fillText(line, 0, 0);
      g.restore();
      if (it.underline) g.fillRect(x, base + 1, Math.ceil(tw), 1);
    });

    if (fs.led) {
      // Snap glyph pixels to fully on/off, like a real LED matrix.
      const img = g.getImageData(0, 0, c.width, c.height);
      const d = img.data;
      for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 110 ? 255 : 0;
      g.putImageData(img, 0, 0);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(it.left, it.top, w, h);
    ctx.clip();
    if (it.outline && !it.outline.transparent && opts.outlines) {
      const o = new OffscreenCanvas(c.width, c.height);
      const og = o.getContext('2d');
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) og.drawImage(c, dx, dy);
      og.globalCompositeOperation = 'source-in';
      og.fillStyle = it.outline.css;
      og.fillRect(0, 0, o.width, o.height);
      og.globalCompositeOperation = 'source-over';
      og.drawImage(c, 0, 0);
      ctx.drawImage(o, it.left - pad, it.top - pad);
    } else {
      ctx.drawImage(c, it.left - pad, it.top - pad);
    }
    ctx.restore();
  }

  async function renderTemplate(canvas, tpl, opts = {}) {
    opts = { backdrop: 'checker', showCodes: false, outlines: true, ...opts };
    canvas.width = tpl.width;
    canvas.height = tpl.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Transparent backgrounds are overlays drawn over live video; show a backdrop.
    if (!tpl.background || tpl.background.transparent) {
      if (opts.backdrop === 'checker') {
        for (let y = 0; y < tpl.height; y += 8)
          for (let x = 0; x < tpl.width; x += 8) {
            ctx.fillStyle = ((x + y) / 8) % 2 ? '#26262b' : '#1b1b1f';
            ctx.fillRect(x, y, 8, 8);
          }
      } else if (opts.backdrop === 'black') {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, tpl.width, tpl.height);
      }
    } else {
      ctx.fillStyle = tpl.background.css;
      ctx.fillRect(0, 0, tpl.width, tpl.height);
    }

    const bg = await decodeImage(tpl.backgroundImage);
    if (bg) ctx.drawImage(bg, 0, 0);

    // Decode every image up front so draw order stays exact.
    const images = await Promise.all(tpl.items.map(it => (it.type === 'Graphic' ? decodeImage(it.image) : null)));

    tpl.items.forEach((it, i) => {
      if (it.type === 'Shape') {
        if (it.fill && !it.fill.transparent) {
          ctx.fillStyle = it.fill.css;
          ctx.fillRect(it.left, it.top, it.width, it.height);
        }
        if (it.stroke && !it.stroke.transparent && it.thickness > 0) {
          ctx.strokeStyle = it.stroke.css;
          ctx.lineWidth = it.thickness;
          const t = it.thickness / 2;
          ctx.strokeRect(it.left + t, it.top + t, it.width - it.thickness, it.height - it.thickness);
        }
      } else if (it.type === 'Graphic') {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        if (images[i]) ctx.drawImage(images[i], it.left, it.top, it.width, it.height);
        ctx.imageSmoothingEnabled = false;
      } else if (it.type === 'Text' || it.type === 'DataText') {
        if (it.background && !it.background.transparent && it.width && it.height) {
          ctx.fillStyle = it.background.css;
          ctx.fillRect(it.left, it.top, it.width, it.height);
        }
        drawText(ctx, it, opts);
      }
    });
    return canvas;
  }

  // Upscale a native-res canvas into `out`, optionally as round LED dots.
  function upscale(out, src, scale, led) {
    out.width = src.width * scale;
    out.height = src.height * scale;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, out.width, out.height);
    if (led && scale >= 3) {
      const tile = new OffscreenCanvas(scale, scale);
      const t = tile.getContext('2d');
      t.fillStyle = '#000';
      t.fillRect(0, 0, scale, scale);
      t.globalCompositeOperation = 'destination-out';
      t.beginPath();
      t.arc(scale / 2, scale / 2, scale * 0.42, 0, Math.PI * 2);
      t.fill();
      ctx.fillStyle = ctx.createPattern(tile, 'repeat');
      ctx.fillRect(0, 0, out.width, out.height);
    }
    return out;
  }

  // Bounding box an item occupies, for hit-testing and highlight outlines.
  function itemBox(it) {
    if (it.type === 'Text' || it.type === 'DataText') {
      const fs = fontSpec(it);
      const lines = (it.text || '').split('\n').length;
      return {
        x: it.left, y: it.top,
        w: Math.max(it.width, 0),
        h: Math.max(it.height || lines * fs.lineHeight, 0),
      };
    }
    return { x: it.left, y: it.top, w: it.width, h: it.height };
  }

  root.DLRender = { renderTemplate, upscale, decodeImage, itemBox, fontSpec };
})(this);
