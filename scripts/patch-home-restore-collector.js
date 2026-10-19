#!/usr/bin/env node
/** 主进程落盘采集器：捕获渲染进程 __codexHomeRestoreDiag 日志并追加写 JSONL。 */
const fs = require('node:fs');
const path = require('node:path');
const { relPath } = require('./patch-util');
const MARKER = '/* CodexRebuildHomeRestoreDiagCollector */';
const PLATFORMS = ['mac-arm64', 'mac-x64', 'win'];
const ANCHOR = 'O.default.app.on(rowser-window-created,a)';
const INJECT = [
  'O.default.app.on(rowser-window-created,a),',
  'O.default.app.on(rowser-window-created,(q3e,w3e)=>{try{w3e.webContents.on(console-message,(q4e,r4e,m4e)=>{try{if(typeof m4e===string&&m4e.includes(__codexHomeRestoreDiag)){const t4e=m4e.slice(m4e.indexOf(__codexHomeRestoreDiag));fs.appendFileSync(process.env.CODEX_HOME_RESTORE_DIAG_LOG||Z:\\TEMP\\CodexRebuild\\cache\\home-restore-diag.jsonl,t4e+\n)}}catch(x4e){}})}catch(x4e){}}),',
].join('');
function patchSource(source) {
  if (source.includes(MARKER)) return { status: 'already-patched', source };
  if (!source.includes('browser-window-created')) return { status: 'not-applicable', source };
  try {
    if (source.split(ANCHOR).length - 1 !== 1) throw new Error('主窗口锚点数量异常');
    const next = source.replace(ANCHOR, INJECT) + MARKER;
    require('acorn').parse(next, { ecmaVersion: 'latest', sourceType: 'module' });
    return { status: 'patched', source: next };
  } catch (error) { return { status: 'unexpected-shape', source, reason: error.message }; }
}
function main() {
  const args = process.argv.slice(2);
  const platform = args.find(a => PLATFORMS.includes(a));
  const check = args.includes('--check');
  const dirs = PLATFORMS.map(item => ({ platform: item, path: path.join(require('./patch-util').SRC_DIR, item, '_asar', '.vite', 'build') })).filter(i => fs.existsSync(i.path));
  let failed = 0, patched = 0;
  for (const d of dirs) {
    try {
      const files = fs.readdirSync(d.path).filter(n => /^main-.*\.js$/.test(n));
      const results = files.map(n => ({ n, s: fs.readFileSync(path.join(d.path, n), 'utf8') })).map(x => ({ n: x.n, r: patchSource(x.s) })).filter(x => x.r.status !== 'not-applicable');
      if (results.length !== 1) throw new Error('main bundle count ' + results.length);
      const t = results[0];
      if (t.r.status === 'unexpected-shape') throw new Error(t.r.reason);
      console.log('  [' + d.platform + '] ' + relPath(path.join(d.path, t.n)));
      if (t.r.status === 'already-patched') { console.log('    [ok] already patched'); }
      else if (check) { console.log('    [ok] anchors verified; dry-run'); }
      else { fs.writeFileSync(path.join(d.path, t.n), t.r.source, 'utf8'); patched++; console.log('    [ok] collector injected'); }
    } catch (e) { console.error('  [x] ' + d.platform + ': ' + e.message); failed++; }
  }
  if (failed) process.exitCode = 1;
}
if (require.main === module) main();
module.exports = { MARKER, patchSource };
