const test = require('node:test');
const assert = require('node:assert/strict');
const { MARKER, PREFIX, patchSource } = require('./patch-home-restore-diagnostics');

function fixture() {
  return [
    'import ' + String.fromCharCode(34) + './codex-rebuild-reading-width.js' + String.fromCharCode(34) + ';',
    'function restore(e,{accountKey:t,auth:n,area:r,navigate:i,productMode:a,state:o}){',
    'let s=e.get(AE),c=e.get(CH),u=remembered(e,{accountKey:t,auth:n,area:r,productMode:a});',
    'if(u==null||!s&&u.departedAt==null||areaOf(e,u.location)!==r){i(`/`);return!0}',
    'function tVa(e,{accountKey:t,auth:n,area:r,navigate:i,productMode:a,state:o}){let s=e.get(AE),c=e.get(ch);let u2=1}',
    'return (s||/* Codex：API-key 首页从其他页面恢复会话。 */t===`auth:apikey`&&r===`home`)?nVa(e,u,o):(i(u.location.pathname,{state:o}),!0)',
    '}',
    'function cuu(){let l=e[4];',
    'let u;',
    '/* Codex：API-key 首页恢复写入。 */u=()=>{QBa(t,{accountKey:l,location:n,productMode:s})};',
    'return u}',
    'let zChain=1',
    ',gO=Y(U,({get:e})=>{let t=e(ch)?.state?.sidebarThreadLocationId;return typeof t==`string`?t:null}),',
    '_O=cs(U,new Map);',
    'function nVa(e,t,n){let r=e.get(eh).prepareNavigation(gc(t.location),{state:{...t.location.state,...n}});return r!=null&&r()!=!0}',
  ].join('');
}

test('diagnostics inject anchors and are idempotent', () => {
  const result = patchSource(fixture());
  assert.equal(result.status, 'patched');
  assert.ok(result.source.includes(MARKER));
  assert.ok(result.source.includes(PREFIX));
  assert.match(result.source, /cuu\.write/);
  assert.match(result.source, /tVa.enter/);
  assert.match(result.source, /gO\.read/);
  assert.match(result.source, /nVa\.enter/);
  assert.match(result.source, /nVa\.prepared/);
  const repeated = patchSource(result.source);
  assert.equal(repeated.status, 'already-patched');
  assert.equal(repeated.source, result.source);
});

test('unrelated bundle stays not-applicable', () => {
  const result = patchSource('function unrelated(){return 1}');
  assert.equal(result.status, 'not-applicable');
});
