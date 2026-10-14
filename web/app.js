// UI: load files, build the gallery, drive the detail view.
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const IMAGE_RE = /\.(png|jpe?g|bmp|gif)$/i;
  const DL_RE = /\.(tpl|seq)$/i;
  const SCB_RE = /\.scb$/i;

  const state = {
    entries: [],        // { path, folder, name, ext, model?, error?, bytes? }
    current: -1,        // index into visible()
    selected: -1,       // selected item index in the detail view
    native: document.createElement('canvas'),
    playing: null,
    startLists: [],     // parsed .scb files, by event number
    sl: { index: -1, heat: 0, diver: 0 },
  };

  const opts = () => ({
    led: $('opt-led').checked,
    showCodes: $('opt-codes').checked,
    boxes: $('opt-boxes').checked,
    backdrop: $('opt-backdrop').value,
    zoom: $('opt-zoom').value,
  });

  // ---------- loading ----------

  async function loadFiles(files) {
    const scb = [...files].filter(f => SCB_RE.test(f.name));
    if (scb.length) await loadStartLists(scb);
    const list = [...files].filter(f => DL_RE.test(f.name) || IMAGE_RE.test(f.name));
    if (!list.length) return;
    let paths = list.map(f => f.webkitRelativePath || f.relPath || f.name);
    // A picked or dropped folder prefixes every path with its own name; drop it.
    const first = paths[0].split('/')[0];
    if (paths.every(p => p.includes('/') && p.split('/')[0] === first)) paths = paths.map(p => p.slice(first.length + 1));
    const fresh = await Promise.all(list.map(async (f, i) => makeEntry(paths[i], new Uint8Array(await f.arrayBuffer()))));
    addEntries(fresh);
  }

  function makeEntry(path, bytes) {
    const parts = path.split('/');
    const name = parts.pop();
    const e = { path, folder: parts.join('/') || '.', name, ext: name.split('.').pop().toLowerCase() };
    if (IMAGE_RE.test(name)) { e.bytes = bytes; return e; }
    try {
      e.model = DLModel.fromRaw(NRBF.parse(bytes));
    } catch (err) {
      e.error = err.message;
    }
    return e;
  }

  function addEntries(fresh) {
    const seen = new Map(state.entries.map(e => [e.path, e]));
    for (const e of fresh) seen.set(e.path, e);
    state.entries = [...seen.values()].sort((a, b) =>
      a.folder === b.folder ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.folder.localeCompare(b.folder));
    $('empty').hidden = true;
    $('side').hidden = false;
    buildTree();
    showGallery();
  }

  // Files the gallery shows: templates and sequences (images only back .seq items).
  const visible = () => {
    const q = $('filter').value.trim().toLowerCase();
    return state.entries.filter(e => DL_RE.test(e.name) && (!q || e.path.toLowerCase().includes(q)));
  };
  const groupByFolder = list => list.reduce((m, e) => (m.get(e.folder) || m.set(e.folder, []).get(e.folder)).push(e) && m, new Map());

  // ---------- sidebar ----------

  function buildTree() {
    const tree = $('tree');
    tree.textContent = '';
    const list = visible();
    for (const [folder, items] of groupByFolder(list)) {
      const box = el('div', 'tree-folder');
      box.append(el('div', 'tf-name', folder === '.' ? 'Top level' : folder));
      for (const e of items) {
        const b = el('button', 'tree-file');
        b.dataset.path = e.path;
        const tag = el('span', 'tag' + (e.error ? ' err' : e.ext === 'seq' ? ' seq' : ''), e.error ? 'ERR' : e.ext.toUpperCase());
        b.append(tag, el('span', 'nm', e.name.replace(DL_RE, '')));
        b.title = e.path;
        b.onclick = () => openDetail(visible().indexOf(e));
        box.append(b);
      }
      tree.append(box);
    }
    markActive();
  }

  function markActive() {
    for (const b of $('tree').querySelectorAll('.tree-file')) {
      const on = !$('detail').hidden && b.dataset.path === state.currentPath;
      b.classList.toggle('active', on);
      if (on) b.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---------- gallery ----------

  let galleryToken = 0;
  async function showGallery() {
    stopPlayback();
    $('detail').hidden = true;
    $('gallery').hidden = false;
    markActive();
    const token = ++galleryToken;
    const g = $('gallery');
    g.textContent = '';
    const list = visible();
    const jobs = [];
    for (const [folder, items] of groupByFolder(list)) {
      const sec = el('section', 'g-folder');
      const h = el('h2', null, folder === '.' ? 'Top level' : folder);
      h.append(el('span', null, `${items.length}`));
      const grid = el('div', 'grid');
      sec.append(h, grid);
      for (const e of items) {
        const card = el('button', 'card' + (e.error ? ' err' : ''));
        const thumb = el('div', 'thumb');
        const meta = el('div', 'meta');
        meta.append(el('span', 'nm', e.name.replace(DL_RE, '')), el('span', 'sub', describe(e)));
        card.append(thumb, meta);
        card.title = e.path;
        card.onclick = () => openDetail(visible().indexOf(e));
        grid.append(card);
        if (e.error) thumb.textContent = 'Could not decode: ' + e.error;
        else if (e.model.kind === 'template') jobs.push([thumb, DLScb.apply(e.model, startListValues())]);
        else if (e.model.kind === 'sequence') {
          const { entry: first } = resolveSeqItem(e.model.items[0], e.path);
          if (first && first.model && first.model.kind === 'template') jobs.push([thumb, DLScb.apply(first.model, startListValues())]);
          else thumb.append(el('div', 'seq-thumb', `▶ ${e.model.items.length} slides`));
        }
      }
      g.append(sec);
    }
    // Render thumbnails progressively so the page stays responsive.
    await document.fonts.ready;
    for (const [thumb, model] of jobs) {
      if (token !== galleryToken) return;
      const c = document.createElement('canvas');
      c.setAttribute('aria-hidden', 'true');
      await DLRender.renderTemplate(c, model, { backdrop: 'checker' });
      thumb.append(c);
    }
  }

  function describe(e) {
    if (e.error) return 'Unreadable';
    const m = e.model;
    if (m.kind === 'template') {
      const data = m.items.filter(i => i.type === 'DataText').length;
      const overlay = !m.background || m.background.transparent;
      return `${m.width}×${m.height} · ${m.items.length} items${data ? ` · ${data} live fields` : ''}${overlay ? ' · overlay' : ''}`;
    }
    if (m.kind === 'sequence') {
      const total = m.items.reduce((s, i) => s + i.seconds, 0);
      return `Sequence · ${m.items.length} slides · ${fmtSecs(total)}${m.loopForever ? ' · loops' : ''}`;
    }
    return m.kind;
  }

  // ---------- detail ----------

  function openDetail(i) {
    const list = visible();
    if (i < 0 || i >= list.length) return;
    stopPlayback();
    state.slides = null;
    state.current = i;
    state.selected = -1;
    const e = list[i];
    state.currentPath = e.path;
    $('gallery').hidden = true;
    $('detail').hidden = false;
    $('d-name').textContent = e.name.replace(DL_RE, '');
    $('big').setAttribute('aria-label', `Preview of ${e.name}`);
    $('d-path').textContent = e.path;
    $('prev').disabled = i === 0;
    $('next').disabled = i === list.length - 1;
    markActive();
    $('main').scrollTop = 0;

    $('seq').hidden = true;
    $('inspector').hidden = false;
    if (e.error) {
      showModel(null);
      $('d-meta').textContent = 'Could not decode: ' + e.error;
    } else if (e.model.kind === 'sequence') {
      buildSequence(e.model, e.path);
    } else {
      showModel(e.model);
    }
  }

  let shown = null, shownBase = null;
  async function showModel(model) {
    shownBase = model;
    model = DLScb.apply(model, startListValues());
    shown = model;
    updateStartListNote();
    const big = $('big');
    if (!model) {
      big.width = big.height = 0;
      $('items').textContent = '';
      return;
    }
    $('d-meta').textContent = `${model.width}×${model.height} px · background ${model.background ? model.background.name : 'none'}${model.backgroundImage ? ' + image' : ''}`;
    fillInspector(model);
    await redraw();
  }

  async function redraw() {
    if (!shown) return;
    const o = opts();
    await document.fonts.ready;
    await DLRender.renderTemplate(state.native, shown, o);
    let scale = o.zoom === 'fit'
      ? fitScale(shown.width, shown.height)
      : +o.zoom;
    DLRender.upscale($('big'), state.native, scale, o.led);
    state.scale = scale;
    drawHighlights();
  }

  // Largest whole-number zoom that fits the stage width and most of the window height.
  function fitScale(w, h) {
    const availW = document.querySelector('.stage-wrap').clientWidth - 48;
    const availH = window.innerHeight * 0.62;
    return Math.max(1, Math.floor(Math.min(availW / w, availH / h)));
  }

  function drawHighlights() {
    const hl = $('hl'), big = $('big');
    hl.width = big.width; hl.height = big.height;
    const ctx = hl.getContext('2d');
    if (!shown) return;
    const s = state.scale;
    const o = opts();
    shown.items.forEach((it, i) => {
      if (!o.boxes && i !== state.selected) return;
      const b = DLRender.itemBox(it);
      ctx.lineWidth = i === state.selected ? 2 : 1;
      ctx.strokeStyle = i === state.selected ? '#ffc928' : 'rgba(124,196,255,.55)';
      ctx.strokeRect(b.x * s + .5, b.y * s + .5, b.w * s - 1, b.h * s - 1);
    });
  }

  function select(i, scrollRow) {
    state.selected = i;
    for (const tr of $('items').children) tr.classList.toggle('sel', +tr.dataset.i === i);
    if (scrollRow && i >= 0) $('items').children[i].scrollIntoView({ block: 'nearest' });
    drawHighlights();
  }

  function fillInspector(model) {
    const tb = $('items');
    tb.textContent = '';
    model.items.forEach((it, i) => {
      const tr = document.createElement('tr');
      tr.dataset.i = i;
      const b = DLRender.itemBox(it);
      const cells = [
        cell(String(i + 1), 'mono muted'),
        (() => { const td = cell(); td.append(el('span', 'type-pill ' + it.type, it.type)); return td; })(),
        cell(`${b.x},${b.y}  ${b.w}×${b.h}`, 'mono'),
        contentCell(it),
        cell(it.fontName ? `${it.fontName}${it.bold ? ' bold' : ''}${it.italic ? ' italic' : ''}` : '', 'mono'),
        colourCell(it),
      ];
      tr.append(...cells);
      tr.onmouseenter = () => select(i);
      tr.onclick = () => select(i);
      tb.append(tr);
    });
  }

  function contentCell(it) {
    const td = cell();
    if (it.type === 'DataText') {
      td.append(el('span', 'k', `${it.code}[${it.index}]`), document.createTextNode(' '),
        el('span', 'txt muted', it.text ? `“${it.text}”` : ''));
      if (it.dataFormat && it.dataFormat !== 'Default') td.append(el('span', 'muted', ` · ${it.dataFormat}`));
    } else if (it.type === 'Text') {
      td.append(el('span', 'txt', it.text || '(empty)'));
      if (it.scroll) td.append(el('span', 'muted', ' · scrolls'));
    } else if (it.type === 'Graphic') {
      td.append(el('span', 'mono', it.filename.split(/[\\/]/).pop() || 'embedded image'));
      if (it.image) td.append(el('span', 'muted', ` · ${(it.image.length / 1024).toFixed(1)} KB embedded`));
    } else if (it.type === 'Shape') {
      td.append(el('span', null, it.shape === 0 ? 'Rectangle' : `Shape ${it.shape}`),
        el('span', 'muted', ` · ${it.thickness}px border`));
    }
    return td;
  }

  function colourCell(it) {
    const td = cell();
    const add = (c, label) => {
      if (!c || c.transparent) return;
      const w = el('div', 'mono');
      const sw = el('span', 'sw'); sw.style.background = c.css;
      w.append(sw, document.createTextNode(label ? `${label} ${c.name}` : c.name));
      td.append(w);
    };
    if (it.type === 'Text' || it.type === 'DataText') {
      add(it.dim ? it.dimColor : it.color);
      add(it.background, 'bg');
    } else if (it.type === 'Shape') {
      add(it.fill, 'fill'); add(it.stroke, 'line');
    }
    return td;
  }

  // ---------- sequences ----------

  function resolveSeqItem(s, path) {
    return DLSequence.resolve(state.entries, s, path);
  }

  async function buildSequence(model, path) {
    const box = $('seq');
    box.textContent = '';
    box.hidden = false;
    $('inspector').hidden = false;
    const total = model.items.reduce((a, s) => a + s.seconds, 0);
    $('d-meta').textContent = `${model.items.length} slides · ${fmtSecs(total)} per cycle · ${model.loopForever ? 'loops forever' : `${model.loops}×`}`;
    $('items').textContent = '';
    const slides = [];
    for (const [i, s] of model.items.entries()) {
      const { entry: target, error } = resolveSeqItem(s, path);
      const card = el('button', 'seq-item');
      const thumb = el('div', 'thumb');
      const meta = el('div', 'meta');
      meta.append(el('span', 'nm', s.name), el('span', 'dur', fmtSecs(s.seconds)));
      card.append(thumb, meta);
      card.title = s.path;
      box.append(card);
      const slide = { card, target, s };
      slides.push(slide);
      card.onclick = () => showSlide(slides, i);
      if (!target) thumb.textContent = error;
      else if (target.bytes) {
        const img = new Image();
        img.src = URL.createObjectURL(new Blob([target.bytes]));
        thumb.append(img);
      } else if (target.model && target.model.kind === 'template') {
        const c = document.createElement('canvas');
        DLRender.renderTemplate(c, target.model, { backdrop: 'checker' }).then(() => thumb.append(c));
      } else thumb.textContent = target.error ? 'Unreadable' : 'Unsupported';
    }
    state.slides = slides;
    startPlayback(slides, model);
  }

  async function showSlide(slides, i, fromTimer) {
    if (!fromTimer) stopPlayback();
    slides.forEach((sl, j) => sl.card.classList.toggle('active', j === i));
    state.slideIndex = i;
    const { target } = slides[i] || {};
    if (target && target.model && target.model.kind === 'template') {
      await showModel(target.model);
    } else if (target && target.bytes) {
      shown = null;
      $('items').textContent = '';
      const img = await DLRender.decodeImage(target.bytes);
      const W = 320, H = 176;   // panel size; images are fit to it like DisplayLink's fit mode
      state.native.width = W; state.native.height = H;
      const ctx = state.native.getContext('2d');
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      if (img) {
        const k = Math.min(W / img.width, H / img.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, (W - img.width * k) / 2, (H - img.height * k) / 2, img.width * k, img.height * k);
      }
      const o = opts();
      state.scale = o.zoom === 'fit' ? fitScale(W, H) : +o.zoom;
      DLRender.upscale($('big'), state.native, state.scale, o.led);
      drawHighlights();
    } else {
      shown = null;
      $('big').width = $('big').height = 0;
      $('items').textContent = '';
    }
  }

  function startPlayback(slides, model) {
    stopPlayback();
    let shownAny = false;
    state.playing = DLSequence.play(
      slides.map(slide => slide.s), model,
      index => { shownAny = true; return showSlide(slides, index, true); },
      error => {
        $('d-meta').textContent = 'Could not play sequence: ' + error.message;
        // Playback refused to start: still show the first slide so the preview isn't blank.
        if (!shownAny && slides.length) showSlide(slides, 0, true);
      },
    );
  }
  function stopPlayback() { if (state.playing) state.playing.stop(); state.playing = null; }

  // ---------- start lists (.scb) ----------

  async function loadStartLists(files) {
    const errors = [];
    for (const f of files) {
      try {
        const list = DLScb.parse(await f.text(), f.name);
        state.startLists = state.startLists.filter(l => l.fileName !== f.name).concat(list);
      } catch (err) { errors.push(err.message); }
    }
    state.startLists.sort((a, b) => a.event.localeCompare(b.event, undefined, { numeric: true }));
    const sel = $('sl-event');
    const keep = (currentStartList() || {}).fileName;
    sel.length = 1;
    for (const l of state.startLists) sel.append(new Option(`#${l.event} ${l.title}`, l.fileName));
    const kept = state.startLists.findIndex(l => l.fileName === keep);
    if (kept < 0) state.sl = { index: state.startLists.length ? 0 : -1, heat: 0, diver: 0 };
    else state.sl.index = kept;
    sel.value = state.sl.index >= 0 ? state.startLists[state.sl.index].fileName : '';
    $('startlist').hidden = !state.startLists.length;
    if (errors.length) $('sl-note').textContent = errors.join(' · ');
    startListChanged();
  }

  const currentStartList = () => state.startLists[state.sl.index] || null;

  function startListValues() {
    const list = currentStartList();
    const meetTitle = $('sl-meet').value.trim();
    if (!list) return meetTitle ? new Map([['MM_SW_MT', meetTitle], ['MM_DV_MT', meetTitle]]) : null;
    return DLScb.fields(list, { heat: state.sl.heat, diver: state.sl.diver, meetTitle });
  }

  // How many heats (swimming) or divers (diving) the current list has.
  function startListSteps() {
    const list = currentStartList();
    if (!list) return 0;
    return list.diving ? DLScb.divers(list).length : list.heats.length;
  }

  function stepStartList(delta) {
    const n = startListSteps();
    if (!n) return;
    const key = currentStartList().diving ? 'diver' : 'heat';
    state.sl[key] = Math.min(n - 1, Math.max(0, state.sl[key] + delta));
    startListChanged();
  }

  function startListChanged() {
    const list = currentStartList();
    const n = startListSteps();
    const at = list ? (list.diving ? state.sl.diver : state.sl.heat) : 0;
    $('sl-pos').textContent = !list ? '' : list.diving
      ? (n ? `Diver ${at + 1} of ${n}` : 'No divers listed')
      : `Heat ${at + 1} of ${n}`;
    $('sl-prev').disabled = !list || at <= 0;
    $('sl-next').disabled = !list || at >= n - 1;
    if (!$('detail').hidden) {
      if (shownBase) showModel(shownBase);
    } else if (!$('gallery').hidden) showGallery();
  }

  function updateStartListNote() {
    if ($('startlist').hidden) return;
    const list = currentStartList();
    $('sl-note').textContent = !shownBase || shownBase.kind !== 'template' ? ''
      : !DLScb.usesStartList(shownBase) ? 'This template has no MM_ start-list fields.'
      : list && !list.diving && !shownBase.items.some(it => /^MM_SW_/.test(it.code || '')) ? 'This is a diving template: pick a diving start list.'
      : list && list.diving && !shownBase.items.some(it => /^MM_DV_/.test(it.code || '')) ? 'This is a swimming template: pick a swimming start list.'
      : '';
  }

  function startListSuffix() {
    const list = currentStartList();
    if (!list) return '';
    return list.diving ? ` - E${list.event} diver ${state.sl.diver + 1}` : ` - E${list.event} H${state.sl.heat + 1}`;
  }

  $('sl-event').addEventListener('change', e => {
    state.sl = { index: state.startLists.findIndex(l => l.fileName === e.target.value), heat: 0, diver: 0 };
    startListChanged();
  });
  $('sl-prev').onclick = () => stepStartList(-1);
  $('sl-next').onclick = () => stepStartList(1);
  $('sl-meet').addEventListener('input', startListChanged);

  // ---------- helpers ----------

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function cell(text, cls) { const td = el('td', cls); if (text) td.textContent = text; return td; }
  function fmtSecs(s) { return s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${+s.toFixed(1)}s`; }

  // ---------- events ----------

  for (const id of ['pick-folder', 'pick-folder-2', 'pick-files']) {
    $(id).addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });
  }
  $('filter').addEventListener('input', () => {
    const cur = state.currentPath;
    buildTree();
    if (!$('gallery').hidden) return showGallery();
    const i = visible().findIndex(e => e.path === cur);
    state.current = i;
    $('prev').disabled = i <= 0;
    $('next').disabled = i < 0 || i >= visible().length - 1;
    markActive();
  });
  $('back').onclick = showGallery;
  $('prev').onclick = () => openDetail(state.current - 1);
  $('next').onclick = () => openDetail(state.current + 1);
  for (const id of ['opt-led', 'opt-codes', 'opt-backdrop', 'opt-zoom']) {
    $(id).addEventListener('change', () => {
      if (shown) redraw();
      else if (state.slides) showSlide(state.slides, state.slideIndex, !!(state.playing && state.playing.active));
    });
  }
  $('opt-boxes').addEventListener('change', drawHighlights);
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (opts().zoom === 'fit' && shown && !$('detail').hidden) redraw(); }, 150);
  });

  $('big').addEventListener('mousemove', e => {
    if (!shown) return;
    const r = $('big').getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * shown.width;
    const y = (e.clientY - r.top) / r.height * shown.height;
    // Topmost item under the cursor (items paint in list order).
    for (let i = shown.items.length - 1; i >= 0; i--) {
      const b = DLRender.itemBox(shown.items[i]);
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) {
        if (i !== state.selected) select(i, true);
        return;
      }
    }
  });

  $('download').onclick = () => {
    const e = visible()[state.current];
    const a = document.createElement('a');
    a.download = (e ? e.name.replace(DL_RE, '') : 'preview') + startListSuffix() + (opts().led ? ' (LED)' : '') + '.png';
    a.href = $('big').toDataURL('image/png');
    a.click();
  };

  document.addEventListener('keydown', e => {
    if ($('detail').hidden || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.key === 'ArrowLeft' && state.current > 0) openDetail(state.current - 1);
    else if (e.key === 'ArrowRight' && state.current >= 0) openDetail(state.current + 1);
    else if (e.key === 'Escape') showGallery();
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && state.sl.index >= 0) {
      e.preventDefault();
      stepStartList(e.key === 'ArrowDown' ? 1 : -1);
    }
  });

  // Drag and drop, including whole folders.
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('dropcover').hidden = false; });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropcover').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', async e => {
    e.preventDefault();
    dragDepth = 0;
    $('dropcover').hidden = true;
    const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    const files = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const f = await new Promise((res, rej) => entry.file(res, rej));
        f.relPath = prefix + f.name;
        files.push(f);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const child of batch) await walk(child, prefix + entry.name + '/');
        } while (batch.length);
      }
    };
    for (const en of entries) await walk(en, '');
    loadFiles(files);
  });

  // When served by serve.py with a library folder, load it automatically.
  (async () => {
    try {
      const res = await fetch('library/index.json', { cache: 'no-store' });
      if (!res.ok) return;
      const paths = await res.json();
      const get = p => fetch('library/' + p.split('/').map(encodeURIComponent).join('/'));
      const lists = paths.filter(p => SCB_RE.test(p));
      if (lists.length) {
        await loadStartLists(await Promise.all(lists.map(async p =>
          new File([await (await get(p)).text()], p.split('/').pop()))));
      }
      const fresh = await Promise.all(paths.filter(p => !SCB_RE.test(p)).map(async p =>
        makeEntry(p, new Uint8Array(await (await get(p)).arrayBuffer()))));
      if (fresh.length) addEntries(fresh);
    } catch { /* opened from file:// or no library: wait for the user */ }
  })();
})();
