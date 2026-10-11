const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function renderer() {
  class Canvas {
    constructor(w, h) {
      this.width = w; this.height = h; this.operations = [];
      this.context = {
        save: () => this.operations.push(['save']),
        restore: () => this.operations.push(['restore']),
        beginPath: () => this.operations.push(['beginPath']),
        rect: (...args) => this.operations.push(['rect', ...args]),
        clip: () => this.operations.push(['clip']),
        clearRect() {}, fillRect() {}, fillText() {}, translate() {}, scale() {},
        measureText: text => ({ width: text.length * 10 }),
        drawImage: (...args) => this.operations.push(['drawImage', ...args]),
        getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }),
        putImageData() {},
      };
    }
    getContext() { return this.context; }
  }
  const context = { OffscreenCanvas: Canvas };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/render.js'), 'utf8'), context);
  return { api: context.DLRender, Canvas };
}

const text = {
  type: 'Text', left: 5, top: 2, width: 10, height: 5, actualWidth: 80,
  text: 'overflow', fontName: 'Arial', fontSize: 12,
  hAlign: 'right', vAlign: 'bottom', color: { css: 'white' },
};

for (const outlines of [false, true]) {
  test(`text is aligned and clipped to declared bounds (outlines=${outlines})`, async () => {
    const { api, Canvas } = renderer();
    const canvas = new Canvas(100, 30);
    await api.renderTemplate(canvas, {
      width: 100, height: 30, background: { css: 'black' },
      items: [{ ...text, outline: { css: 'red', transparent: false } }],
    }, { outlines });
    assert.deepEqual(canvas.operations.find(op => op[0] === 'rect'), ['rect', 5, 2, 10, 5]);
    const painted = canvas.operations.find(op => op[0] === 'drawImage');
    assert.equal(painted[1].width, 14);
    assert.equal(painted[1].height, 9);
    assert.ok(canvas.operations.findIndex(op => op[0] === 'clip') < canvas.operations.indexOf(painted));
    assert.deepEqual(canvas.operations.at(-1), ['restore']);
    assert.deepEqual(JSON.parse(JSON.stringify(api.itemBox(text))), { x: 5, y: 2, w: 10, h: 5 });
  });
}

test('zero-width text does not paint hidden placeholders', async () => {
  const { api, Canvas } = renderer();
  const canvas = new Canvas(100, 30);
  await api.renderTemplate(canvas, {
    width: 100, height: 30, background: { css: 'black' }, items: [{ ...text, width: 0 }],
  });
  assert.equal(canvas.operations.length, 0);
});

test('multiline boxes retain their explicit height for hit testing', () => {
  const { api } = renderer();
  const box = api.itemBox({ ...text, text: 'first\nsecond', height: 10 });
  assert.equal(box.h, 10);
});
