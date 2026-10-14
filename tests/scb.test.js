const assert = require('node:assert/strict');
const test = require('node:test');
const { parse, fields, apply, divers, usesStartList } = require('../web/scb.js');

// Made-up names only: real start lists hold swimmers' names and stay out of the repo.
const pad = (name, team) => name.padEnd(20) + '--' + team.padEnd(16);
const blank = pad('', '');
const swim = ['#2 WOMEN OPEN 200 FREESTYLE', blank, blank, pad('Doe, Jane', 'AAAA'), pad('Roe, Rita', 'BBBB'),
  blank, blank, blank, blank, blank, blank, pad('Poe, Pat', 'AAAA'), ...Array(9).fill(blank)].join('\n');

test('parses the event header and 10-lane heats', () => {
  const l = parse(swim, 'E002.scb');
  assert.equal(l.event, '2');
  assert.equal(l.title, 'WOMEN OPEN 200 FREESTYLE');
  assert.equal(l.diving, false);
  assert.equal(l.heats.length, 2);
  assert.deepEqual(l.heats[0][2], { name: 'Doe, Jane', team: 'AAAA' });
  assert.deepEqual(l.heats[0][0], { name: '', team: '' });
  assert.deepEqual(l.heats[1][0], { name: 'Poe, Pat', team: 'AAAA' });
});

test('accepts CRLF, a BOM and a missing final newline; rejects a bad header', () => {
  const l = parse('﻿#12 WOMEN OPEN 400 FREESTYLE RELAY\r\n' + pad('AAAA A', 'AAAA') + '\r\n', 'E012.scb');
  assert.equal(l.event, '12');
  assert.equal(l.heats.length, 1);
  assert.deepEqual(l.heats[0][0], { name: 'AAAA A', team: 'AAAA' });
  assert.throws(() => parse('WOMEN 50 FREE\n' + blank), /first line/);
});

test('fields fill every lane of the chosen heat, blanking empty lanes', () => {
  const v = fields(parse(swim), { heat: 0, meetTitle: 'Test Invite' });
  assert.equal(v.get('MM_SW_ET'), 'WOMEN OPEN 200 FREESTYLE');
  assert.equal(v.get('MM_SW_MT'), 'Test Invite');
  assert.equal(v.get('MM_SW_NM:3'), 'Doe, Jane');
  assert.equal(v.get('MM_SW_AF:4'), 'BBBB');
  assert.equal(v.get('MM_SW_NM:1'), '');
  assert.equal(fields(parse(swim), { heat: 1 }).get('MM_SW_NM:1'), 'Poe, Pat');
});

test('diving lists step through divers in order', () => {
  const dive = parse(['#5 WOMEN OPEN 11 1M DIVING', pad('Doe, Jane', 'AAAA'), blank, pad('Roe, Rita', 'BBBB')].join('\n'));
  assert.equal(dive.diving, true);
  assert.equal(divers(dive).length, 2);
  const v = fields(dive, { diver: 1 });
  assert.equal(v.get('MM_DV_NM'), 'Roe, Rita');
  assert.equal(v.get('MM_DV_ET'), 'WOMEN OPEN 11 1M DIVING');
});

test('apply swaps matching DataText items and leaves the template untouched', () => {
  const dt = (code, index, text) => ({ type: 'DataText', code, index, text, actualWidth: 49 });
  const model = { kind: 'template', items: [dt('MM_SW_ET', 12, '50 Meter Freestyle'), dt('MM_SW_NM', 3, 'Name3'),
    dt('SCBD_SW_TM', 3, '0:00.00'), { type: 'Text', text: 'LANE' }] };
  assert.equal(usesStartList(model), true);
  const out = apply(model, fields(parse(swim)));
  assert.equal(out.items[0].text, 'WOMEN OPEN 200 FREESTYLE');
  assert.equal(out.items[1].text, 'Doe, Jane');
  assert.equal(out.items[1].actualWidth, 0);
  assert.equal(out.items[2], model.items[2]);
  assert.equal(model.items[1].text, 'Name3');
  assert.equal(apply(model, null), model);
});
