#!/usr/bin/env node
/** 在现有浏览器验证阅读运行模块；模拟官方 CSS 变量契约，不冒充完整 Electron 验收。 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const html = `<!doctype html><html data-codex-window-type="electron"><meta charset="utf-8"><title>阅读布局功能验证</title>
<style>:root{--thread-content-expanded-max-width:768px;--thread-content-compact-max-width:640px;--thread-content-max-width:768px;--codex-window-zoom:1;--app-color-text-accent:#2563eb}body{margin:16px;font-family:system-ui;color:#111827}.stage{width:1800px;--thread-content-responsive-max-width:var(--thread-content-expanded-max-width)}.column{--thread-content-max-width:var(--thread-content-responsive-max-width);width:100%;max-width:var(--thread-content-max-width);box-sizing:border-box}.wide{width:100%;max-width:var(--markdown-wide-block-max-width,600px)}.codex-dialog{height:90px;border:1px solid;box-sizing:border-box}#fixture{position:absolute;left:-10000px}pre{white-space:pre-wrap}</style>
<style>:is([data-codex-window-type=browser],[data-codex-window-type=chrome-extension],[data-codex-window-type=electron]) body{--thread-content-max-width:48rem}</style>
<h1>阅读布局功能验证</h1><p>模拟官方布局契约，执行真实阅读偏好模块；完整设置页面仍需候选 GUI 验收。</p><div id="controls"></div><pre id="results">运行中</pre>
<div id="fixture"><div class="stage"><div class="column" data-selected-text-overlay-target><strong>粗体内容</strong><pre class="wide">代码块</pre><table class="wide"><tr><td>表格</td></tr></table></div><div class="column composer">输入区域</div></div><div class="codex-dialog codex-rebuild-dialog-default">对话框</div></div>
<script>if(!location.search.includes('restored')){localStorage.setItem('codex-rebuild:reading-width:v1','85');localStorage.setItem('codex-rebuild:markdown-bold-color-mode:v1','default');localStorage.setItem('codex-rebuild:markdown-bold-custom-color:v1','#7c3aed');}</script>
<script type="module">
import {WIDTHS,MIN_WIDTH_PERCENT,MAX_WIDTH_PERCENT,WIDTH_STEP,STORAGE_KEY,BOLD_COLOR_MODES,BOLD_MODE_STORAGE_KEY,BOLD_CUSTOM_COLOR_STORAGE_KEY,renderReadingWidth} from '/reading-width.mjs';
const results=[], states=[];let cursor=0;
const react={useState(init){const index=cursor++;states[index]??=typeof init==='function'?init():init;return [states[index],value=>states[index]=value]},useEffect(){}};
react.Fragment=Symbol('Fragment');
const ui={jsx(type,props){const element=type===react.Fragment?document.createDocumentFragment():typeof type==='function'?type(props):document.createElement(type);if(type===react.Fragment||typeof type!=='function')for(const [key,value]of Object.entries(props)){if(key==='children'){for(const child of [value].flat())if(child!==false&&child!=null)element.append(child instanceof Node?child:document.createTextNode(String(child)));}else if(key==='onChange')element.addEventListener('change',event=>value({currentTarget:event.currentTarget}));else if(key==='className')element.className=value;else if(key==='style')Object.assign(element.style,value);else if(key==='disabled')element.disabled=value;else element.setAttribute(key,value);}if(props.value!==undefined&&'value'in element)element.value=props.value;return element},jsxs(type,props){return this.jsx(type,props)}};
const Row=props=>ui.jsx('label',{children:[props.label,props.control]});
const control=renderReadingWidth(react,ui,Row,{locale:'zh-CN'});document.querySelector('#controls').append(control);
const widthControl=document.querySelector('[data-codex-rebuild-width-control]'),widthOutput=widthControl.nextElementSibling,boldSelect=document.querySelector('[data-codex-rebuild-bold-color-control]'),boldPicker=document.querySelector('[data-codex-rebuild-bold-custom-color]'),stage=document.querySelector('.stage'),column=document.querySelector('.column'),composer=document.querySelector('.composer');
function check(name,test){if(!test)throw Error(name);results.push(name)}
function width(element){return element.getBoundingClientRect().width}
function storageChange(key,value){localStorage.setItem(key,value);window.dispatchEvent(new StorageEvent('storage',{key,newValue:value,storageArea:localStorage}));}
try{
  check('当前百分比偏好直接读取',!location.search.includes('restored')?widthControl.value==='85':true);
  if(location.search.includes('restored')){check('刷新后保持 85%',widthControl.value==='85');check('启动时样式已恢复',document.documentElement.dataset.codexRebuildReadingWidth==='85');check('刷新后保持自定义粗体色并显示颜色选择器',boldSelect.value==='custom'&&boldPicker&&getComputedStyle(document.querySelector('strong')).color==='rgb(124, 58, 237)');}
  check('50% 到 100% 步进 5%',widthControl.type==='range'&&Number(widthControl.min)===MIN_WIDTH_PERCENT&&Number(widthControl.max)===MAX_WIDTH_PERCENT&&Number(widthControl.step)===WIDTH_STEP&&WIDTHS.length===11&&WIDTHS[0]==='50'&&WIDTHS.at(-1)==='100');
  check('百分比读数可见',widthOutput?.textContent==='85%');
  check('粗体颜色 3 档完整',boldSelect.options.length===3&&BOLD_COLOR_MODES.join(',')==='default,accent,custom');
  if(!location.search.includes('restored'))check('正文色为默认且不显示自定义颜色选择器',getComputedStyle(document.querySelector('strong')).color==='rgb(17, 24, 39)'&&boldPicker===null);
  storageChange(BOLD_MODE_STORAGE_KEY,'accent');check('粗体跟随官方强调色',getComputedStyle(document.querySelector('strong')).color==='rgb(37, 99, 235)');
  storageChange(BOLD_CUSTOM_COLOR_STORAGE_KEY,'#7c3aed');storageChange(BOLD_MODE_STORAGE_KEY,'custom');check('粗体使用自定义颜色',getComputedStyle(document.querySelector('strong')).color==='rgb(124, 58, 237)');
  storageChange(BOLD_MODE_STORAGE_KEY,'default');check('粗体恢复正文颜色',getComputedStyle(document.querySelector('strong')).color==='rgb(17, 24, 39)');
  for(const preset of WIDTHS){widthControl.value=preset;widthControl.dispatchEvent(new Event('change'));stage.style.width='1800px';const expected=Math.min(1800,Math.max(768,1800*Number(preset)/100));check(preset+' 正文/输入区同宽',Math.abs(width(column)-expected)<1&&Math.abs(width(composer)-expected)<1);for(const block of document.querySelectorAll('.wide'))check(preset+' 宽块跟随正文',Math.abs(width(block)-expected)<1);stage.style.width='420px';check(preset+' 窄窗不溢出',Math.abs(width(column)-420)<1&&Math.abs(width(composer)-420)<1);}
  for(const preset of WIDTHS){widthControl.value=preset;widthControl.dispatchEvent(new Event('change'));const configured=getComputedStyle(document.body).getPropertyValue('--thread-content-max-width').replaceAll(' ','');check(preset+' 保留官方下限并覆盖高优先级规则',configured.includes('48rem')&&configured.includes(preset+'%'));}
  const dialog=document.querySelector('.codex-dialog');for(const zoom of [1,2]){document.documentElement.style.setProperty('--codex-window-zoom',zoom);check('对话框缩放 '+zoom,width(dialog)<=innerWidth/zoom-31&&width(dialog)<=720);check('对话框高度保留',width(dialog)>0&&dialog.getBoundingClientRect().height===90);}
  widthControl.value='85';widthControl.dispatchEvent(new Event('change'));check('百分比偏好已写入',localStorage.getItem(STORAGE_KEY)==='85');
  if(!location.search.includes('restored')){storageChange(BOLD_CUSTOM_COLOR_STORAGE_KEY,'#7c3aed');storageChange(BOLD_MODE_STORAGE_KEY,'custom');location.replace('/?restored=1');}else{widthControl.value='50';widthControl.dispatchEvent(new Event('change'));storageChange(BOLD_MODE_STORAGE_KEY,'default');check('50% 保留官方下限并恢复正文色',document.querySelector('#codex-rebuild-reading-style').textContent.includes('max(48rem,50%)')&&getComputedStyle(document.querySelector('strong')).color==='rgb(17, 24, 39)');document.querySelector('#results').textContent=JSON.stringify({passed:true,checks:results.length,results},null,2);}
}catch(error){document.querySelector('#results').textContent=JSON.stringify({passed:false,error:error.message,results},null,2);}
</script></html>`;
const server = http.createServer((req,res)=>{
  res.setHeader("Cache-Control", "no-store");
  if(req.url === "/reading-width.mjs"){res.setHeader("Content-Type","text/javascript; charset=utf-8");res.end(fs.readFileSync(path.join(__dirname,"runtime","reading-width.mjs")));}
  else{res.setHeader("Content-Type","text/html; charset=utf-8");res.end(html);}
});
server.listen(Number(process.env.REBUILD_SMOKE_PORT || 0),"127.0.0.1",()=>console.log(`Reading smoke: http://127.0.0.1:${server.address().port}/`));
