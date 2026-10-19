#!/usr/bin/env node
/** 临时诊断采集器：在主进程入口顶部订阅所有窗口的 console 消息并追加到专用 JSONL。 */
const fs = require('node:fs');
const path = require('node:path');
const { relPath, SRC_DIR } = require('./patch-util');
const MARKER = '/* CodexRebuildHomeRestoreDiagCollector */';
const PLATFORMS = ['mac-arm64', 'mac-x64', 'win'];
const INJECT = [
  '/* CodexRebuildHomeRestoreDiagCollector */',
  '(()=>{try{const electron=require(' + JSON.stringify('electron') + '),fs=require(' + JSON.stringify('node:fs') + '),app=electron.app;',
  'const output=' + JSON.stringify('Z:\\TEMP\\CodexRebuild\\cache\\home-restore-diag.jsonl') + ';',
  'const write=(value)=>{if(typeof value!==' + JSON.stringify('string') + ')return;const marker=value.includes(' + JSON.stringify('__codexHomeRestoreDiag') + ')?' + JSON.stringify('__codexHomeRestoreDiag') + ':value.includes(' + JSON.stringify('DIAG ') + ')?' + JSON.stringify('DIAG ') + ':null;if(marker==null)return;try{fs.appendFileSync(output,value.slice(value.indexOf(marker))+' + JSON.stringify('\n') + ')}catch{}};',
  'const hook=(webContents)=>{try{if(webContents==null||webContents.isDestroyed?.())return;webContents.on(' + JSON.stringify('console-message') + ',(event,level,message,line,sourceId)=>{for(const value of [event?.message,level?.message,typeof level===' + JSON.stringify('string') + '?level:null,message?.message,typeof message===' + JSON.stringify('string') + '?message:null]){if(typeof value===' + JSON.stringify('string') + '&&(value.includes(' + JSON.stringify('__codexHomeRestoreDiag') + ')||value.includes(' + JSON.stringify('DIAG ') + '))){write(value);break}}})}catch{}};',
  'app.on(' + JSON.stringify('web-contents-created') + ',(event,webContents)=>hook(webContents));',
  'app.on(' + JSON.stringify('browser-window-created') + ',(event,window)=>hook(window?.webContents??window));',
  'for(const window of electron.BrowserWindow.getAllWindows())hook(window.webContents);',
  'write(' + JSON.stringify('__codexHomeRestoreDiag collector-ready') + ');',
  '}catch{}})();',
].join('');

function patchSource(source) {
  if (source.includes(MARKER)) return { status: 'already-patched', source };
  try {
    const next = INJECT + source;
    require('acorn').parse(next, { ecmaVersion: 'latest', sourceType: 'module' });
    return { status: 'patched', source: next };
  } catch (error) {
    return { status: 'unexpected-shape', source, reason: error.message };
  }
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) => PLATFORMS.includes(arg));
  const check = args.includes('--check');
  const dirs = PLATFORMS.map((item) => ({
    platform: item,
    path: path.join(SRC_DIR, item, '_asar', '.vite', 'build'),
  })).filter((item) => fs.existsSync(item.path));
  let failed = 0;
  let patched = 0;
  for (const directory of dirs) {
    try {
      const results = fs.readdirSync(directory.path)
        .filter((name) => /^main-.*\.js$/.test(name))
        .map((name) => ({ name, source: fs.readFileSync(path.join(directory.path, name), 'utf8') }))
        .map((item) => ({ ...item, result: patchSource(item.source) }));
      if (results.length !== 1) throw new Error('main bundle count ' + results.length);
      const target = results[0];
      if (target.result.status === 'unexpected-shape') throw new Error(target.result.reason);
      console.log('  [' + directory.platform + '] ' + relPath(path.join(directory.path, target.name)));
      if (target.result.status === 'already-patched') {
        console.log('    [ok] already patched');
      } else if (check) {
        console.log('    [ok] anchors verified; dry-run');
      } else {
        fs.writeFileSync(path.join(directory.path, target.name), target.result.source, 'utf8');
        patched++;
        console.log('    [ok] collector injected');
      }
    } catch (error) {
      console.error('  [x] ' + directory.platform + ': ' + error.message);
      failed++;
    }
  }
  if (!dirs.length) {
    console.error('  [x] missing platform assets');
    failed++;
  }
  if (failed) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { MARKER, patchSource };
