const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { MARKER, patchSource } = require('./patch-home-restore-collector');

test('collector runs at main entry and captures both console payloads', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-collector-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = 'const electron=require(' + JSON.stringify('electron') + ');globalThis.entryExecuted=true;';
  const patched = patchSource(original);
  assert.equal(patched.status, 'patched');
  assert.ok(patched.source.startsWith(MARKER));
  assert.equal(patchSource(patched.source).status, 'already-patched');

  const appHandlers = new Map();
  const consoleHandlers = [];
  const mainWindow = {
    webContents: {
      isDestroyed: () => false,
      on: (event, callback) => {
        assert.equal(event, 'console-message');
        consoleHandlers.push(callback);
      },
    },
  };
  const app = { on: (event, callback) => appHandlers.set(event, callback) };
  const fakeRequire = (name) => {
    if (name === 'electron') return { app, BrowserWindow: { getAllWindows: () => [mainWindow] } };
    return require(name);
  };
  const context = {
    require: fakeRequire,
    console: { warn: (value) => { throw new Error(value); } },
  };
  vm.runInNewContext(patched.source, context);
  assert.equal(context.entryExecuted, true);
  assert.equal(consoleHandlers.length, 1);

  const replacement = patched.source.replace(
    JSON.stringify('Z:\\TEMP\\CodexRebuild\\cache\\home-restore-diag.jsonl'),
    JSON.stringify(path.join(root, 'diag.jsonl')),
  );
  assert.notEqual(replacement, patched.source);
  const isolatedConsoleHandlers = [];
  const isolatedMain = {
    webContents: {
      isDestroyed: () => false,
      on: (_event, callback) => isolatedConsoleHandlers.push(callback),
    },
  };
  const isolatedApp = { on: () => {} };
  vm.runInNewContext(replacement, {
    require: (name) => name === 'electron'
      ? { app: isolatedApp, BrowserWindow: { getAllWindows: () => [isolatedMain] } }
      : require(name),
  });
  const log = path.join(root, 'diag.jsonl');
  assert.match(fs.readFileSync(log, 'utf8'), /collector-ready/);
  isolatedConsoleHandlers[0]({ message: 'DIAG __codexHomeRestoreDiag details' });
  isolatedConsoleHandlers[0]('old', 3, 'DIAG __codexHomeRestoreDiag old');
  assert.match(fs.readFileSync(log, 'utf8'), /__codexHomeRestoreDiag details/);
  assert.match(fs.readFileSync(log, 'utf8'), /__codexHomeRestoreDiag old/);
});

test('renderer console events use the same listener', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-collector-payload-'));
  const source = patchSource('const e=require(' + JSON.stringify('electron') + ');').source.replace(
    JSON.stringify('Z:\\TEMP\\CodexRebuild\\cache\\home-restore-diag.jsonl'),
    JSON.stringify(path.join(root, 'diag.jsonl')),
  );
  let webContentsHandler;
  let rendererHandler;
  const app = { on: (event, callback) => { if (event === 'web-contents-created') webContentsHandler = callback; } };
  const webContents = {
    isDestroyed: () => false,
    on: (_event, callback) => { rendererHandler = callback; },
  };
  vm.runInNewContext(source, {
    require: (name) => name === 'electron'
      ? { app, BrowserWindow: { getAllWindows: () => [] } }
      : require(name),
  });
  webContentsHandler({}, webContents);
  rendererHandler({ level: 3, message: 'DIAG __codexHomeRestoreDiag payload' });
  assert.match(fs.readFileSync(path.join(root, 'diag.jsonl'), 'utf8'), /__codexHomeRestoreDiag payload/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('renderer diagnostics using the DIAG prefix are captured', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-collector-diagnostic-'));
  const source = patchSource('const e=require(' + JSON.stringify('electron') + ');').source.replace(
    JSON.stringify('Z:\\TEMP\\CodexRebuild\\cache\\home-restore-diag.jsonl'),
    JSON.stringify(path.join(root, 'diag.jsonl')),
  );
  let webContentsHandler;
  let rendererHandler;
  const app = { on: (event, callback) => { if (event === 'web-contents-created') webContentsHandler = callback; } };
  const webContents = {
    isDestroyed: () => false,
    on: (_event, callback) => { rendererHandler = callback; },
  };
  vm.runInNewContext(source, {
    require: (name) => name === 'electron'
      ? { app, BrowserWindow: { getAllWindows: () => [] } }
      : require(name),
  });
  webContentsHandler({}, webContents);
  rendererHandler({ level: 3, message: 'DIAG tVa.enter' }, '{"current":"/local/thread-a"}');
  const text = fs.readFileSync(path.join(root, 'diag.jsonl'), 'utf8');
  assert.match(text, /DIAG tVa\.enter/);
  assert.match(text, /\{"current":"\/local\/thread-a"\}/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('modern Electron details payload preserves both diagnostic values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-collector-details-'));
  const source = patchSource('const e=require(' + JSON.stringify('electron') + ');').source.replace(
    JSON.stringify('Z:\\TEMP\\CodexRebuild\\cache\\home-restore-diag.jsonl'),
    JSON.stringify(path.join(root, 'diag.jsonl')),
  );
  let webContentsHandler;
  let rendererHandler;
  const app = { on: (event, callback) => { if (event === 'web-contents-created') webContentsHandler = callback; } };
  const webContents = {
    isDestroyed: () => false,
    on: (_event, callback) => { rendererHandler = callback; },
  };
  vm.runInNewContext(source, {
    require: (name) => name === 'electron'
      ? { app, BrowserWindow: { getAllWindows: () => [] } }
      : require(name),
  });
  webContentsHandler({}, webContents);
  rendererHandler({ level: 3, message: 'DIAG tVa.enter' }, '{"current":"/local/thread-a"}');
  assert.match(fs.readFileSync(path.join(root, 'diag.jsonl'), 'utf8'),
    /DIAG tVa\.enter \{"current":"\/local\/thread-a"\}/);
  fs.rmSync(root, { recursive: true, force: true });
});
