// Turns raw NRBF object trees into a tidy model for the renderer.
(function (root) {
  'use strict';

  // System.Drawing.KnownColor enum. 1-26 are Windows system colours (classic
  // defaults), 27 Transparent, 28-167 the web colours in enum order, 168+ more system colours.
  const SYSTEM = {
    1: '#B4B4B4', 2: '#99B4D1', 3: '#000000', 4: '#ABABAB', 5: '#F0F0F0', 6: '#A0A0A0',
    7: '#696969', 8: '#E3E3E3', 9: '#FFFFFF', 10: '#000000', 11: '#000000', 12: '#6D6D6D',
    13: '#0078D7', 14: '#FFFFFF', 15: '#0066CC', 16: '#F4F7FC', 17: '#BFCDDB', 18: '#000000',
    19: '#FFFFE1', 20: '#000000', 21: '#F0F0F0', 22: '#000000', 23: '#C8C8C8', 24: '#FFFFFF',
    25: '#646464', 26: '#000000', 27: 'transparent',
    168: '#F0F0F0', 169: '#FFFFFF', 170: '#A0A0A0', 171: '#B9D1EA', 172: '#D7E4F2',
    173: '#F0F0F0', 174: '#3399FF',
  };
  const WEB = ('AliceBlue AntiqueWhite Aqua Aquamarine Azure Beige Bisque Black BlanchedAlmond Blue ' +
    'BlueViolet Brown BurlyWood CadetBlue Chartreuse Chocolate Coral CornflowerBlue Cornsilk Crimson ' +
    'Cyan DarkBlue DarkCyan DarkGoldenrod DarkGray DarkGreen DarkKhaki DarkMagenta DarkOliveGreen ' +
    'DarkOrange DarkOrchid DarkRed DarkSalmon DarkSeaGreen DarkSlateBlue DarkSlateGray DarkTurquoise ' +
    'DarkViolet DeepPink DeepSkyBlue DimGray DodgerBlue Firebrick FloralWhite ForestGreen Fuchsia ' +
    'Gainsboro GhostWhite Gold Goldenrod Gray Green GreenYellow Honeydew HotPink IndianRed Indigo ' +
    'Ivory Khaki Lavender LavenderBlush LawnGreen LemonChiffon LightBlue LightCoral LightCyan ' +
    'LightGoldenrodYellow LightGray LightGreen LightPink LightSalmon LightSeaGreen LightSkyBlue ' +
    'LightSlateGray LightSteelBlue LightYellow Lime LimeGreen Linen Magenta Maroon MediumAquamarine ' +
    'MediumBlue MediumOrchid MediumPurple MediumSeaGreen MediumSlateBlue MediumSpringGreen ' +
    'MediumTurquoise MediumVioletRed MidnightBlue MintCream MistyRose Moccasin NavajoWhite Navy ' +
    'OldLace Olive OliveDrab Orange OrangeRed Orchid PaleGoldenrod PaleGreen PaleTurquoise ' +
    'PaleVioletRed PapayaWhip PeachPuff Peru Pink Plum PowderBlue Purple Red RosyBrown RoyalBlue ' +
    'SaddleBrown Salmon SandyBrown SeaGreen SeaShell Sienna Silver SkyBlue SlateBlue SlateGray Snow ' +
    'SpringGreen SteelBlue Tan Teal Thistle Tomato Turquoise Violet Wheat White WhiteSmoke Yellow ' +
    'YellowGreen').split(' ');
  const KNOWN_NAMES = {};
  WEB.forEach((n, i) => { KNOWN_NAMES[28 + i] = n; });

  // System.Drawing.Color -> { css, name, transparent } (or null when unset)
  function color(c) {
    if (!c || c.$type !== 'System.Drawing.Color') return null;
    const STATE_KNOWN = 1, STATE_VALUE = 2, STATE_NAMED = 8;
    if (c.state & STATE_KNOWN && c.knownColor) {
      const k = c.knownColor;
      if (k === 27) return { css: 'rgba(0,0,0,0)', name: 'Transparent', transparent: true };
      if (KNOWN_NAMES[k]) return { css: KNOWN_NAMES[k].toLowerCase(), name: KNOWN_NAMES[k], transparent: false };
      return { css: SYSTEM[k] || '#000', name: `System colour ${k}`, transparent: false };
    }
    if (c.state & STATE_VALUE) {
      const v = c.value >>> 0;
      const a = (v >>> 24) & 255, r = (v >>> 16) & 255, g = (v >>> 8) & 255, b = v & 255;
      const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
      return { css: `rgba(${r},${g},${b},${a / 255})`, name: a === 255 ? hex : `${hex} @${Math.round(a / 2.55)}%`, transparent: a === 0 };
    }
    if (c.state & STATE_NAMED && c.name) return { css: c.name, name: c.name, transparent: c.name === 'Transparent' };
    return null;
  }

  // Inherited fields arrive as "TemplateItem+<Left>k__BackingField": key them by bare name.
  // The most-derived class comes first, so the first occurrence wins.
  function flatten(o) {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      const bare = k.split('+').pop().replace('k__BackingField', '').replace(/^[<>]+|[<>]+$/g, '');
      if (!(bare in out)) out[bare] = v;
    }
    return out;
  }

  const enumVal = e => (e && typeof e === 'object' && 'value__' in e ? e.value__ : e);
  const listItems = l => (l && l._items ? l._items.slice(0, l._size) : Array.isArray(l) ? l : []);
  const bitmap = b => (b && b.Data instanceof Uint8Array ? b.Data : null);

  const ALIGN = {
    1: ['left', 'top'], 2: ['center', 'top'], 4: ['right', 'top'],
    16: ['left', 'middle'], 32: ['center', 'middle'], 64: ['right', 'middle'],
    256: ['left', 'bottom'], 512: ['center', 'bottom'], 1024: ['right', 'bottom'],
  };
  const DATA_FORMAT = { 0: 'Default', 1: 'Format 1', 2: 'Format 2', 3: 'Format 3', 4: 'Format 4' };

  function item(raw) {
    const f = flatten(raw);
    const type = raw.$type.split('.').pop().replace('TemplateItem', '') || 'Item';
    const base = {
      type, raw,
      left: f.Left | 0, top: f.Top | 0, width: f.width | 0, height: f.height | 0,
      locked: !!f.Locked,
    };
    if (type === 'Text' || type === 'DataText') {
      const align = ALIGN[enumVal(f.Alignment)] || ['left', 'top'];
      Object.assign(base, {
        text: f._textToDraw || '',
        fontName: f.fontName || '',
        fontSize: f.fontSize || 12,
        bold: !!f.fontBold, italic: !!f.fontItalic, underline: !!f.fontUnderline,
        dim: !!f.fontDim,
        color: color(f.fontColor), dimColor: color(f.dimFontColor),
        outline: color(f.outlineColor), background: color(f.backgroundColor),
        hAlign: align[0], vAlign: align[1],
        scroll: !!f.Scroll,
        actualWidth: f.ActualWidth | 0,
      });
      if (type === 'DataText') {
        Object.assign(base, {
          source: f.SourceClass || '', code: f.Code || '', index: f.Index,
          dataFormat: DATA_FORMAT[enumVal(f.DataFormat)] ?? null,
        });
        // DataText boxes keep their row height in "Height"; the base height is always 0.
        if (!base.height) base.height = f.Height | 0;
      }
    } else if (type === 'Graphic') {
      base.image = bitmap(f.graphic);
      base.filename = f.graphicFilename || '';
    } else if (type === 'Shape') {
      base.shape = enumVal(f.shape);
      base.thickness = f.thickness || 0;
      base.fill = color(f.BackgroundColor);
      base.stroke = color(f.OutlineColor);
    }
    return base;
  }

  function template(raw) {
    const f = flatten(raw);
    return {
      kind: 'template',
      width: f.width | 0, height: f.height | 0,
      background: color(f.Background),
      backgroundImage: bitmap(f.backgroundGraphic),
      description: f.Description || '',
      items: listItems(f.items).filter(Boolean).map(item),
    };
  }

  const TRANSITION_TICKS = 10000000; // .NET ticks per second

  function sequence(raw) {
    const f = flatten(raw);
    return {
      kind: 'sequence',
      loopForever: !!f.LoopForever,
      loops: f._loopIterations,
      items: listItems({ _items: f._items, _size: f._size }).filter(Boolean).map(s => ({
        path: s.fileName || '',
        name: (s.fileName || '').split(/[\\/]/).pop(),
        seconds: (s.durationTime || 0) / TRANSITION_TICKS,
        isImage: enumVal(s.itemType) === 1,
        transition: enumVal(s.incomingTransition),
      })),
    };
  }

  function library(raw) {
    const f = flatten(raw);
    const kv = (f.fileMetadata && f.fileMetadata.KeyValuePairs) || [];
    return {
      kind: 'library',
      folder: f.folderPath || '',
      files: kv.filter(Boolean).map(p => ({
        name: p.value.Name, path: p.value.Filename, type: p.value.FileType,
        updated: p.value.LastUpdated, thumbnail: bitmap(p.value.Thumbnail),
      })),
    };
  }

  function fromRaw(raw) {
    const t = (raw && raw.$type) || '';
    if (t.endsWith('.Templates.Template')) return template(raw);
    if (t.endsWith('.GraphicSequence')) return sequence(raw);
    if (t.endsWith('.FolderMetadata')) return library(raw);
    return { kind: 'unknown', type: t };
  }

  const api = { fromRaw, color, KNOWN_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DLModel = api;
})(this);
