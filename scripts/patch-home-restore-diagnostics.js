#!/usr/bin/env node
/**
 * 首页恢复诊断日志（临时补丁，确诊后移除）。
 * 只注入只读日志，不改变任何业务行为；锚点漂移必须失败。
 */
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('acorn');
const { relPath, SRC_DIR } = require('./patch-util');
const MARKER = '/* CodexRebuildHomeRestoreDiag */';
const PLATFORMS = ['mac-arm64', 'mac-x64', 'win'];
const PREFIX = '__codexHomeRestoreDiag';
function targetDirectories(platform) {
  const requested = platform ? [platform] : PLATFORMS;
  return requested.map((item) => ({
    platform: item,
    path: path.join(SRC_DIR, item, '_asar', 'webview', 'assets'),
  })).filter((item) => fs.existsSync(item.path));
}
function stmt(tag, expression) {
  const entry = '({tag:' + JSON.stringify(tag) + ',at:Date.now(),data:' + expression + '})';
  return '(window.' + PREFIX + '??=[]).push(' + entry + '),globalThis.console.log(' + JSON.stringify('DIAG ' + tag) + ',JSON.stringify(' + expression + '));';
}
function logCall(tag, expression) {
  return '(window.' + PREFIX + '??=[]).push({tag:' + JSON.stringify(tag) + ',at:Date.now(),data:' + expression + '}),globalThis.console.log(' + JSON.stringify('DIAG ' + tag) + ',JSON.stringify(' + expression + '));';
}
function replaceUnique(source, anchor, replacement, message) {
  if (source.split(anchor).length - 1 !== 1) throw new Error(message);
  return source.replace(anchor, replacement);
}
function patchSource(source) {
  if (source.includes(MARKER)) return { status: 'already-patched', source };
  if (!source.includes('Codex：API-key 首页恢复写入。') ||
      !source.includes('Codex：API-key 首页从其他页面恢复会话。')) {
    return { status: 'not-applicable', source };
  }
  try {
    parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    let next = source;
    const writerAnchor = 'u=()=>{QBa(t,{accountKey:l,location:n,productMode:s})}';
    next = replaceUnique(next, writerAnchor,
      'u=()=>{'
      + logCall('cuu.write', '{accountKey:l,pathname:n?.pathname,state:n?.state}')
      + 'QBa(t,{accountKey:l,location:n,productMode:s})}',
      '首页写入端锚点缺失');
    const tVaHead='function tVa(e,{accountKey:t,auth:n,area:r,navigate:i,productMode:a,state:o}){let s=e.get(AE),c=e.get(ch);';
    next = replaceUnique(next, tVaHead,
      tVaHead + stmt('tVa.enter', '{accountKey:t,area:r,current:c?.pathname,currentState:c?.state}'),
      'tVa head anchor missing');
    const consumerAnchor = ',gO=Y(U,({get:e})=>{let t=e(ch)?.state?.sidebarThreadLocationId;';
    next = replaceUnique(next, consumerAnchor,
      ',gO=Y(U,({get:e})=>{'
      + stmt('gO.read', '{pathname:e(ch)?.pathname,state:e(ch)?.state}')
      + 'let t=e(ch)?.state?.sidebarThreadLocationId;',
      '首页消费端锚点缺失');
    const navAnchor = 'function nVa(e,t,n){let r=e.get(eh).prepareNavigation(gc(t.location),{state:{...t.location.state,...n}});return r!=null&&';
    next = replaceUnique(next, navAnchor,
      'function nVa(e,t,n){'
      + stmt('nVa.enter', '{target:t.location?.pathname,targetSearch:t.location?.search,targetState:t.location?.state,mergedState:{...t.location?.state,...n}}')
      + 'let r=e.get(eh).prepareNavigation(gc(t.location),{state:{...t.location.state,...n}}),diagPreparedTarget=gc(t.location);'
      + stmt('nVa.preparedTarget', 'diagPreparedTarget')
      + stmt('nVa.prepared', '{prepared:r!=null}')
      + 'return r!=null&&',
      '首页跳转端锚点缺失');
    if (!next.includes(MARKER)) {
      next = MARKER + next;
    }
    parse(next, { ecmaVersion: 'latest', sourceType: 'module' });
    return { status: 'patched', source: next };
  } catch (error) {
    return { status: 'unexpected-shape', source, reason: error.message };
  }
}
function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) => PLATFORMS.includes(arg));
  const check = args.includes('--check');
  const directories = targetDirectories(platform);
  let failed = 0;
  let patched = 0;
  for (const directory of directories) {
    try {
      const results = fs.readdirSync(directory.path)
        .filter((name) => /^app-initial-.*\.js$/.test(name))
        .map((name) => ({ name, path: path.join(directory.path, name) }))
        .map((file) => ({ file, result: patchSource(fs.readFileSync(file.path, 'utf8')) }))
        .filter((item) => item.result.status !== 'not-applicable');
      if (results.length > 1) throw new Error('bundle-count ' + results.length);
      if (!results.length) {
        console.log('    [skip] api-key home patch not applied yet; diagnostics not applicable');
        continue;
      }
      const target = results[0];
      if (target.result.status === 'unexpected-shape') throw new Error(target.result.reason);
      console.log('  [' + directory.platform + '] ' + relPath(target.file.path));
      if (target.result.status === 'already-patched') {
        console.log('    [ok] already patched');
      } else if (check) {
        console.log('    [ok] anchors verified; dry-run');
      } else {
        fs.writeFileSync(target.file.path, target.result.source, 'utf8');
        patched++;
        console.log('    [ok] diagnostics injected');
      }
    } catch (error) {
      console.error('  [x] ' + directory.platform + ': ' + error.message);
      failed++;
    }
  }
  if (!directories.length) {
    console.error('  [x] missing platform assets');
    failed++;
  }
  if (failed) process.exitCode = 1;
  else console.log('  [ok] ' + patched + ' platform bundle(s) patched');
}
if (require.main === module) main();
module.exports = { MARKER, PREFIX, patchSource };
