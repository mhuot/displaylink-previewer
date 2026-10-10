// Decode every DisplayLink file under a folder with web/nrbf.js and print a
// normalized JSON dump per file, for diffing against nrbf.py output.
// Usage: node tools/parity.js <templates-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { parse } = require('../web/nrbf.js');

const [src, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });

// Mirror nrbf.py's simplify() so the two dumps are comparable.
function simplify(v) {
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (Array.isArray(v)) return v.map(simplify);
  if (v && typeof v === 'object') {
    if (v instanceof Date) return { DateTime_ticks: v.getTime() * 10000 + 621355968000000000 };
    const t = v.$type || '';
    if (t === 'System.Drawing.Color') {
      if (v.name) return v.name;
      if (v.state === 0 && (v.value || 0) === 0) return null;
      if (v.knownColor) return `known:${v.knownColor}`;
      return '#' + ((v.value >>> 0).toString(16).toUpperCase().padStart(8, '0'));
    }
    if (t === 'System.Drawing.Bitmap') return { $type: t, Data: simplify(v.Data) };
    if (t.startsWith('System.Collections.Generic.List'))
      return (v._items || []).slice(0, v._size).map(simplify);
    if (t === 'System.Drawing.Point' || t === 'System.Drawing.Size') {
      const { $type, ...rest } = v; return rest;
    }
    if ('value__' in v && Object.keys(v).length === 2) return `${t.split('.').pop()}=${v.value__}`;
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k.replace('k__BackingField', '').replace(/^[<>]+|[<>]+$/g, '')] = simplify(x);
    return o;
  }
  return v;
}

let ok = 0, bad = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(tpl|seq)$|^lib\.cache$/.test(e.name)) continue;
    const rel = path.relative(src, p);
    try {
      const tree = parse(fs.readFileSync(p));
      fs.writeFileSync(path.join(out, rel.replace(/[\/ ]/g, '_') + '.json'), JSON.stringify(simplify(tree), null, 1));
      ok++;
    } catch (err) {
      console.log('ERR', rel, err.message); bad++;
    }
  }
})(src);
console.log(`${ok} ok, ${bad} failed`);
