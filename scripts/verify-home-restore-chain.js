const fs = require('node:fs');
const { parse } = require('acorn');
const home = require('./patch-api-key-home-navigation');
const diagnostics = require('./patch-home-restore-diagnostics');
const collector = require('./patch-home-restore-collector');

const rendererPath = process.argv[2];
const mainPath = process.argv[3];
if (!rendererPath || !mainPath) throw new Error('usage: node scripts/verify-home-restore-chain.js <app-initial.js> <main.js>');

function stripPriorDiagnostics(source) {
  const marker = '/* CodexRebuildHomeRestoreDiag */';
  if (!source.startsWith(marker)) return source;
  const call = ',console.log("DIAG cuu.write {accountKey:l,pathname:n?.pathname,state:n?.state}")';
  if (!source.includes(call)) throw new Error('instrumented writer log missing');
  return source.slice(marker.length).replace(call, '').replace('window.__codexHomeRestoreDiag??=[])).push(({', 'window.__codexHomeRestoreDiag??=[]).push({');
}

function validateRenderer(source) {
  const navigation = home.patchSource(source);
  if (navigation.status === 'unexpected-shape') throw new Error('home navigation ' + navigation.reason);
  if (navigation.status === 'not-applicable') throw new Error('home navigation missing');
  const observed = diagnostics.patchSource(navigation.source);
  if (observed.status === 'unexpected-shape') throw new Error('diagnostics ' + observed.reason);
  if (observed.status !== 'patched' && observed.status !== 'already-patched') throw new Error('diagnostics missing');
  parse(observed.source, { ecmaVersion: 'latest', sourceType: 'module' });
  return { navigation: navigation.status, diagnostics: observed.status, source: observed.source };
}

const original = fs.readFileSync(rendererPath, 'utf8');
validateRenderer(original);
const cleanRenderer = stripPriorDiagnostics(original);
const observedRenderer = validateRenderer(cleanRenderer);
const observedMain = collector.patchSource(fs.readFileSync(mainPath, 'utf8'));
if (observedMain.status === 'unexpected-shape') throw new Error('collector ' + observedMain.reason);
if (observedMain.status === 'patched') parse(observedMain.source, { ecmaVersion: 'latest', sourceType: 'module' });
console.log(JSON.stringify({
  cleanNavigation: home.patchSource(cleanRenderer).status,
  diagnostics: observedRenderer.diagnostics,
  collector: observedMain.status,
  diagCalls: observedRenderer.source.split('globalThis.console.log').length - 1,
}));
