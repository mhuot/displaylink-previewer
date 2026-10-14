// CTS .scb start lists (Hy-Tek / Meet Maestro export) and MM_ field substitution.
//
// One file per event. Line 1 is "#<event> <title>". Then 10 lines per heat, one per
// lane: a 20-character name, "--", then the team. Relays put "TEAM A" in the name slot.
(function (root) {
  'use strict';

  const LANES = 10;
  const NAME_WIDTH = 20;

  function parse(text, fileName = '') {
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
    const head = /^#\s*(\S+)\s*(.*)$/.exec(lines[0] || '');
    if (!head) throw new Error(`${fileName || 'Start list'}: first line is not "#<event> <title>"`);
    const lanes = lines.slice(1);
    while (lanes.length && !lanes[lanes.length - 1].trim()) lanes.pop();
    const heats = [];
    for (let i = 0; i < Math.max(lanes.length, 1); i += LANES) {
      heats.push(Array.from({ length: LANES }, (_, k) => entry(lanes[i + k] || '')));
    }
    const title = head[2].trim();
    return {
      fileName, event: head[1], title,
      diving: /\bDIVING\b/i.test(title),
      heats,
    };
  }

  function entry(line) {
    let name, team;
    if (line.slice(NAME_WIDTH, NAME_WIDTH + 2) === '--') {
      name = line.slice(0, NAME_WIDTH); team = line.slice(NAME_WIDTH + 2);
    } else {
      const cut = line.indexOf('--');
      name = cut < 0 ? line : line.slice(0, cut);
      team = cut < 0 ? '' : line.slice(cut + 2);
    }
    return { name: name.trim(), team: team.trim() };
  }

  // Divers in start order, across all heats.
  const divers = list => list.heats.flat().filter(e => e.name || e.team);

  // Field values for one heat (swimming) or one diver (diving), keyed "CODE" or "CODE:index".
  function fields(list, { heat = 0, diver = 0, meetTitle = '' } = {}) {
    const v = new Map();
    if (meetTitle) { v.set('MM_SW_MT', meetTitle); v.set('MM_DV_MT', meetTitle); }
    if (list.diving) {
      const d = divers(list)[diver] || { name: '', team: '' };
      v.set('MM_DV_ET', list.title);
      v.set('MM_DV_NM', d.name);
      v.set('MM_DV_AF', d.team);
    } else {
      const lanes = list.heats[heat] || list.heats[0];
      v.set('MM_SW_ET', list.title);
      lanes.forEach((e, i) => { v.set(`MM_SW_NM:${i + 1}`, e.name); v.set(`MM_SW_AF:${i + 1}`, e.team); });
    }
    return v;
  }

  // A copy of the template with matching DataText items showing the start-list values.
  // Lane fields match by index; single-value fields (event, meet title, current diver) match any index.
  function apply(model, values) {
    if (!values || !model || model.kind !== 'template') return model;
    let changed = false;
    const items = model.items.map(it => {
      if (it.type !== 'DataText') return it;
      const key = values.has(`${it.code}:${it.index}`) ? `${it.code}:${it.index}` : it.code;
      if (!values.has(key)) return it;
      changed = true;
      // ActualWidth measured the sample text; drop it so real names are clipped by the box, not squeezed.
      return { ...it, text: values.get(key), actualWidth: 0 };
    });
    return changed ? { ...model, items } : model;
  }

  const usesStartList = model => !!model && model.kind === 'template'
    && model.items.some(it => it.type === 'DataText' && /^MM_/.test(it.code));

  const api = { parse, fields, apply, divers, usesStartList, LANES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DLScb = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
