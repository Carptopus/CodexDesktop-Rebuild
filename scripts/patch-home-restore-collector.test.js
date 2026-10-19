const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { MARKER, patchSource } = require('./patch-home-restore-collector');

function fixture() {
  const tick = String.fromCharCode(96);
  return 'const e=require(' + JSON.stringify('node:events') + '),O=e.a(require(' + JSON.stringify('electron') + '),1);function attach(n,r){let a=(e,t)=>{},i=()=>{};return O.default.app.on(' + tick + 'browser-window-created' + tick + ',a),n.push(()=>{O.default.app.removeListener(' + tick + 'browser-window-created' + tick + ',a)}),i}';
}

function captureConsole(source, options, legacy) {
  const tick = String.fromCharCode(96);
  const first = 'O.default.app.on(' + tick + 'browser-window-created' + tick + ',a),';
  const start = source.indexOf(first) + first.length;
  const end = source.indexOf(',n.push(', start);
  let appHandler;
  let consoleHandler;
  let written;
  const fs = { appendFileSync: (_file, data) => { written = data; } };
  const app = { on: (_event, callback) => { appHandler = callback; } };
  const webContents = { on: (_event, callback) => { consoleHandler = callback; } };
  const we = { webContents };
  vm.runInNewContext(source.slice(start, end), { O: { default: { app } }, app, fs, we });
  appHandler({}, we);
  consoleHandler(...(legacy ? ['old-api', options.level, options.message] : ['new-api', options]));
  return written;
}

test('collector patches actual main-process listener and forwards both Electron signatures', () => {
  const patched = patchSource(fixture());
  assert.equal(patched.status, 'patched');
  assert.ok(patched.source.includes(MARKER));
  assert.ok(patched.source.includes('app.on(' + String.fromCharCode(96) + 'browser-window-created' + String.fromCharCode(96)));
  assert.equal(patchSource(patched.source).status, 'already-patched');
  assert.equal(
    captureConsole(patched.source, { level: 3, message: 'DIAG __codexHomeRestoreDiag new' }),
    '__codexHomeRestoreDiag new\n',
  );
  assert.equal(
    captureConsole(patched.source, { level: 3, message: 'DIAG __codexHomeRestoreDiag old' }, true),
    '__codexHomeRestoreDiag old\n',
  );
});

test('collector needs the evaluated main-process window listener', () => {
  assert.equal(patchSource('unrelated').status, 'not-applicable');
  assert.equal(patchSource('browser-window-created O.default.app.on(' + String.fromCharCode(96) + 'browser-window-created' + String.fromCharCode(96) + ',a),').status, 'unexpected-shape');
});
