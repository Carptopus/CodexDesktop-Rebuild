#!/usr/bin/env node
/** 临时诊断采集器：把首页恢复链路的 console 调用结果追加到专用 JSONL。 */
const fs = require('node:fs');
const path = require('node:path');
const { relPath, SRC_DIR } = require('./patch-util');
const MARKER = '/* CodexRebuildHomeRestoreDiagCollector */';
const PLATFORMS = ['mac-arm64', 'mac-x64', 'win'];
const ANCHOR = 'O.default.app.on(' + String.fromCharCode(96) + 'browser-window-created' + String.fromCharCode(96) + ',a),';
const COLLECTOR = [
  'O.default.app.on(' + String.fromCharCode(96) + 'browser-window-created' + String.fromCharCode(96) + ',(ce,we)=>{try{',
  'we.webContents.on(' + String.fromCharCode(96) + 'console-message' + String.fromCharCode(96) + ',(Ee,Se,Ie)=>{try{',
  'const De=typeof Ie===' + String.fromCharCode(39) + 'string' + String.fromCharCode(39) + '?Ie:typeof Se===' + String.fromCharCode(39) + 'string' + String.fromCharCode(39) + '?Se:Ee?.message;',
  'if(typeof De===' + String.fromCharCode(39) + 'string' + String.fromCharCode(39) + '&&De.includes(' + String.fromCharCode(39) + '__codexHomeRestoreDiag' + String.fromCharCode(39) + '))',
  'fs.appendFileSync(' + String.fromCharCode(39) + 'Z:\\TEMP\\CodexRebuild\\cache\\home-restore-diag.jsonl' + String.fromCharCode(39) + ',De.slice(De.indexOf(' + String.fromCharCode(39) + '__codexHomeRestoreDiag' + String.fromCharCode(39) + '))+' + String.fromCharCode(39) + '\\n' + String.fromCharCode(39) + ')',
  '}catch(xe){}})}catch(xe){}}),',
].join('');

function patchSource(source) {
  if (source.includes(MARKER)) return { status: 'already-patched', source };
  if (!source.includes('browser-window-created')) return { status: 'not-applicable', source };
  try {
    if (source.split(ANCHOR).length - 1 !== 1) throw new Error('main listener anchor count ' + (source.split(ANCHOR).length - 1));
    const next = source.replace(ANCHOR, ANCHOR + COLLECTOR) + MARKER;
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
        .map((item) => ({ ...item, result: patchSource(item.source) }))
        .filter((item) => item.result.status !== 'not-applicable');
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
