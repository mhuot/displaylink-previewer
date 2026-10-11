// MS-NRBF (.NET BinaryFormatter) decoder.
// Turns a .tpl / .seq / lib.cache byte buffer into plain JS objects.
// Classic script (works from file://) that also loads under Node via require().
(function (root) {
  'use strict';

  // PrimitiveTypeEnumeration -> reader
  const PRIM = {
    1: r => r.u8() !== 0,          // Boolean
    2: r => r.u8(),                // Byte
    3: r => r.char(),              // Char (UTF-8)
    5: r => r.str(),               // Decimal (serialized as string)
    6: r => r.f64(),               // Double
    7: r => r.i16(),               // Int16
    8: r => r.i32(),               // Int32
    9: r => r.i64(),               // Int64
    10: r => r.i8(),               // SByte
    11: r => r.f32(),              // Single
    12: r => r.i64(),              // TimeSpan (ticks)
    13: r => new Date(Number(((r.u64() & 0x3FFFFFFFFFFFFFFFn) - 621355968000000000n) / 10000n)), // DateTime
    14: r => r.u16(),              // UInt16
    15: r => r.u32(),              // UInt32
    16: r => r.u64(),              // UInt64
    18: r => r.str(),              // String
  };

  class Reader {
    constructor(buf) {
      this.u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      this.v = new DataView(this.u.buffer, this.u.byteOffset, this.u.byteLength);
      this.p = 0;
    }
    get eof() { return this.p >= this.u.length; }
    u8() {
      if (this.eof) throw new Error(`unexpected end of NRBF stream at ${this.p}`);
      return this.u[this.p++];
    }
    i8() { return this.v.getInt8(this.p++); }
    i16() { const x = this.v.getInt16(this.p, true); this.p += 2; return x; }
    u16() { const x = this.v.getUint16(this.p, true); this.p += 2; return x; }
    i32() { const x = this.v.getInt32(this.p, true); this.p += 4; return x; }
    u32() { const x = this.v.getUint32(this.p, true); this.p += 4; return x; }
    i64() { const x = this.v.getBigInt64(this.p, true); this.p += 8; return Number(x); }
    u64() { const x = this.v.getBigUint64(this.p, true); this.p += 8; return x; }
    f32() { const x = this.v.getFloat32(this.p, true); this.p += 4; return x; }
    f64() { const x = this.v.getFloat64(this.p, true); this.p += 8; return x; }
    bytes(n) {
      if (!Number.isInteger(n) || n < 0 || n > this.u.length - this.p)
        throw new Error(`invalid or truncated NRBF byte range at ${this.p}`);
      const b = this.u.subarray(this.p, this.p + n); this.p += n; return b;
    }
    str() {
      let n = 0;
      for (let shift = 0; shift < 35; shift += 7) {
        const c = this.u8();
        n += (c & 0x7f) * 2 ** shift;
        if (!(c & 0x80)) {
          if (n > 0x7fffffff) throw new Error('invalid NRBF string length');
          return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes(n));
        }
      }
      throw new Error('invalid NRBF string length prefix');
    }
    char() {
      const c = this.u[this.p];
      const len = c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
      return new TextDecoder().decode(this.bytes(len));
    }
  }

  class Ref { constructor(id) { this.id = id; } }
  class Nulls { constructor(n) { this.n = n; } }
  const END = Symbol('end');

  function parse(buf) {
    const r = new Reader(buf);
    const objs = new Map();
    const classes = new Map();
    const libs = new Map();

    const readPrim = t => {
      const f = PRIM[t];
      if (!f) throw new Error(`unsupported primitive type ${t} at ${r.p}`);
      return f(r);
    };

    function classInfo() {
      const id = r.i32(), name = r.str(), n = r.i32();
      const members = [];
      for (let i = 0; i < n; i++) members.push(r.str());
      return { id, name, members };
    }

    function memberTypes(n) {
      const bt = [];
      for (let i = 0; i < n; i++) bt.push(r.u8());
      return bt.map(t => {
        if (t === 0 || t === 7) return [t, r.u8()];
        if (t === 3) return [t, r.str()];
        if (t === 4) return [t, [r.str(), r.i32()]];
        return [t, null];
      });
    }

    function readMembers(cls) {
      const o = { $type: cls.name };
      cls.members.forEach((m, i) => {
        const [bt, ex] = cls.types[i];
        o[m] = bt === 0 ? readPrim(ex) : record();
      });
      return o;
    }

    function fill(n) {
      const out = [];
      while (out.length < n) {
        const v = record();
        if (v instanceof Nulls) for (let i = 0; i < v.n; i++) out.push(null);
        else out.push(v);
      }
      return out;
    }

    function record(allowEnd = false) {
      const rt = r.u8();
      switch (rt) {
        case 0: throw new Error('unexpected NRBF serialization header');
        case 12: { const id = r.i32(); libs.set(id, r.str()); return record(allowEnd); } // BinaryLibrary
        case 4: case 5: {                                           // (System)ClassWithMembersAndTypes
          const ci = classInfo();
          ci.types = memberTypes(ci.members.length);
          if (rt === 5) ci.library = libs.get(r.i32());
          classes.set(ci.id, ci);
          const o = readMembers(ci); objs.set(ci.id, o); return o;
        }
        case 2: case 3: throw new Error(`untyped class record ${rt} not supported`);
        case 1: {                                                   // ClassWithId
          const id = r.i32(), meta = classes.get(r.i32());
          const o = readMembers(meta); objs.set(id, o); return o;
        }
        case 6: { const id = r.i32(), s = r.str(); objs.set(id, s); return s; } // BinaryObjectString
        case 8: return readPrim(r.u8());                            // MemberPrimitiveTyped
        case 9: return new Ref(r.i32());                            // MemberReference
        case 10: return null;                                       // ObjectNull
        case 13: return new Nulls(r.u8());                          // ObjectNullMultiple256
        case 14: return new Nulls(r.i32());                         // ObjectNullMultiple
        case 15: {                                                  // ArraySinglePrimitive
          const id = r.i32(), n = r.i32(), t = r.u8();
          let v;
          if (t === 2) v = r.bytes(n).slice();                      // byte[] -> Uint8Array copy
          else { v = []; for (let i = 0; i < n; i++) v.push(readPrim(t)); }
          objs.set(id, v); return v;
        }
        case 16: case 17: {                                         // ArraySingleObject / ArraySingleString
          const id = r.i32(), n = r.i32();
          const v = fill(n); objs.set(id, v); return v;
        }
        case 7: {                                                   // BinaryArray
          const id = r.i32(), at = r.u8(), rank = r.i32();
          const lens = [];
          for (let i = 0; i < rank; i++) lens.push(r.i32());
          if (at === 3 || at === 4 || at === 5) for (let i = 0; i < rank; i++) r.i32();
          const bt = r.u8();
          let ex = null;
          if (bt === 0 || bt === 7) ex = r.u8();
          else if (bt === 3) ex = r.str();
          else if (bt === 4) ex = [r.str(), r.i32()];
          const total = lens.reduce((a, b) => a * b, 1);
          let v;
          if (bt === 0) { v = []; for (let i = 0; i < total; i++) v.push(readPrim(ex)); }
          else v = fill(total);
          objs.set(id, v); return v;
        }
        case 11:
          if (!allowEnd) throw new Error('unexpected NRBF MessageEnd inside a value');
          return END;
        default: throw new Error(`unknown record type ${rt} at offset ${r.p - 1}`);
      }
    }

    if (r.u8() !== 0) throw new Error('missing NRBF serialization header');
    const rootId = r.i32();
    r.i32(); // header ID
    if (r.i32() !== 1 || r.i32() !== 0) throw new Error('unsupported NRBF version');
    while (true) {
      if (r.eof) throw new Error('missing NRBF MessageEnd');
      if (record(true) === END) break;
    }
    // lib.cache can retain stale bytes after its first complete stream.
    if (!objs.has(rootId)) throw new Error(`missing NRBF root object ${rootId}`);

    // Replace Ref placeholders in place; shared objects stay shared.
    const done = new Set();
    const resolve = v => {
      if (v instanceof Ref) {
        if (!objs.has(v.id)) throw new Error(`missing NRBF object reference ${v.id}`);
        return resolve(objs.get(v.id));
      }
      if (v && typeof v === 'object' && !(v instanceof Uint8Array) && !done.has(v)) {
        done.add(v);
        for (const k of Object.keys(v)) v[k] = resolve(v[k]);
      }
      return v;
    };
    return resolve(objs.get(rootId));
  }

  const api = { parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NRBF = api;
})(this);
