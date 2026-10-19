const fs=require('fs');
const acorn=require('acorn');
const src=fs.readFileSync('Z:/TEMP/diag-reports/source-evidence/webview/app-initial-5851df3f6cb1.js','utf8');
const { patchSource: homePatch }=require('./patch-api-key-home-navigation.js');
const home=homePatch(src).source;
const { patchSource: diagPatch }=require('./patch-home-restore-diagnostics.js');
const diag=diagPatch(home);
if(diag.status!=='patched'){console.log('diag failed:',diag.reason);process.exit(1);}
acorn.parse(diag.source,{ecmaVersion:'latest',sourceType:'module'});
console.log('parsed-ok');
const again=diagPatch(diag.source);
console.log('second:',again.status);
console.log('marker-at-start:', diag.source.startsWith('/* CodexRebuildHomeRestoreDiag */'));
