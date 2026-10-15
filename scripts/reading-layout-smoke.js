#!/usr/bin/env node
/** 在现有浏览器验证阅读运行模块；模拟官方 CSS 变量契约，不冒充完整 Electron 验收。 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const html = `<!doctype html><html data-codex-window-type="electron"><meta charset="utf-8"><title>阅读布局功能验证</title>
<style>:root{--thread-content-expanded-max-width:760px;--thread-content-compact-max-width:640px;--thread-content-max-width:760px;--codex-window-zoom:1}body{margin:16px;font-family:system-ui}.stage{width:1800px;--thread-content-responsive-max-width:var(--thread-content-expanded-max-width)}.column{--thread-content-max-width:var(--thread-content-responsive-max-width);width:100%;max-width:var(--thread-content-max-width);box-sizing:border-box}.wide{width:100%;max-width:var(--markdown-wide-block-max-width,600px)}.codex-dialog{height:90px;border:1px solid;box-sizing:border-box}#fixture{position:absolute;left:-10000px}pre{white-space:pre-wrap}</style>
<style>:is([data-codex-window-type=browser],[data-codex-window-type=chrome-extension],[data-codex-window-type=electron]) body{--thread-content-max-width:48rem}</style>
<h1>阅读布局功能验证</h1><p>模拟官方布局契约，执行真实阅读偏好模块；完整设置页面仍需候选 GUI 验收。</p><div id="controls"></div><pre id="results">运行中</pre>
<div id="fixture"><div class="stage"><div class="column" data-selected-text-overlay-target><strong>粗体内容</strong><pre class="wide">代码块</pre><table class="wide"><tr><td>表格</td></tr></table></div><div class="column composer">输入区域</div></div><div class="codex-dialog codex-rebuild-dialog-default">对话框</div></div>
<script type="module">
import {WIDTHS,STORAGE_KEY,renderReadingWidth} from '/reading-width.mjs';
const results=[], states=[];let cursor=0;
const react={useState(init){const index=cursor++;states[index]??=typeof init==='function'?init():init;return [states[index],value=>states[index]=value]},useEffect(){}};
const ui={jsx(type,props){if(typeof type==='function')return type(props);const element=document.createElement(type);for(const [key,value]of Object.entries(props)){if(key==='children'){for(const child of [value].flat())element.append(child instanceof Node?child:document.createTextNode(String(child)));}else if(key==='onChange')element.addEventListener('change',event=>value({currentTarget:event.currentTarget}));else if(key==='className')element.className=value;else element.setAttribute(key,value);}if(props.value!==undefined)element.value=props.value;return element},jsxs(type,props){return this.jsx(type,props)}};
const Row=props=>ui.jsx('label',{children:[props.label,props.control]});
const control=renderReadingWidth(react,ui,Row,{locale:'zh-CN'});document.querySelector('#controls').append(control);
const select=document.querySelector('select'), stage=document.querySelector('.stage'), column=document.querySelector('.column'), composer=document.querySelector('.composer');
function check(name,test){if(!test)throw Error(name);results.push(name)}
function width(element){return element.getBoundingClientRect().width}
try{
  if(location.search.includes('restored')){check('刷新后保持 1280 档',select.value==='1280');check('启动时样式已恢复',document.documentElement.dataset.codexRebuildReadingWidth==='1280');}
  check('8 档选择项完整',select.options.length===8);
  for(const preset of WIDTHS){select.value=preset;select.dispatchEvent(new Event('change'));stage.style.width='1800px';const expected=preset==='default'?760:preset==='full'?1800:Number(preset);check(preset+' 正文/输入区同宽',Math.abs(width(column)-expected)<1&&Math.abs(width(composer)-expected)<1);for(const block of document.querySelectorAll('.wide'))check(preset+' 宽块跟随正文',Math.abs(width(block)-expected)<1);stage.style.width='420px';check(preset+' 窄窗收缩',Math.abs(width(column)-420)<1&&Math.abs(width(composer)-420)<1);}
  for(const preset of WIDTHS.filter(value=>value!=='default')){select.value=preset;select.dispatchEvent(new Event('change'));check(preset+' 覆盖官方 body 高优先级规则',getComputedStyle(document.body).getPropertyValue('--thread-content-max-width').trim()===(preset==='full'?'100%':preset+'px'));}
  const strong=document.querySelector('strong');check('粗体绿色',getComputedStyle(strong).color==='rgb(0, 162, 64)');
  const dialog=document.querySelector('.codex-dialog');for(const zoom of [1,2]){document.documentElement.style.setProperty('--codex-window-zoom',zoom);check('对话框缩放 '+zoom,width(dialog)<=innerWidth/zoom-31&&width(dialog)<=720);check('对话框高度保留',width(dialog)>0&&dialog.getBoundingClientRect().height===90);}
  select.value='1280';select.dispatchEvent(new Event('change'));check('偏好已写入',localStorage.getItem(STORAGE_KEY)==='1280');
  if(!location.search.includes('restored')){location.replace('/?restored=1');}else{select.value='default';select.dispatchEvent(new Event('change'));check('默认恢复官方变量',!document.querySelector('#codex-rebuild-reading-style').textContent.includes('body{--thread-content'));document.querySelector('#results').textContent=JSON.stringify({passed:true,checks:results.length,results},null,2);}
}catch(error){document.querySelector('#results').textContent=JSON.stringify({passed:false,error:error.message,results},null,2);}
</script></html>`;
const server = http.createServer((req,res)=>{
  res.setHeader("Cache-Control", "no-store");
  if(req.url === "/reading-width.mjs"){res.setHeader("Content-Type","text/javascript; charset=utf-8");res.end(fs.readFileSync(path.join(__dirname,"runtime","reading-width.mjs")));}
  else{res.setHeader("Content-Type","text/html; charset=utf-8");res.end(html);}
});
server.listen(Number(process.env.REBUILD_SMOKE_PORT || 0),"127.0.0.1",()=>console.log(`Reading smoke: http://127.0.0.1:${server.address().port}/`));
