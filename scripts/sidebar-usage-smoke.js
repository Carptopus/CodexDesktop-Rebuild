#!/usr/bin/env node
/** 执行补丁生成的组件和额度渲染链；--asar 可核验真实候选，不启动或修改 GUI。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { parse } = require("acorn");
const { nodes, unique } = require("./patch-ast-util");
const { MODULE, MARKER, COMPONENT, ACCOUNT_COMPONENT, RENDER, findSidebarTarget, isSidebarSignature, patchSource } = require("./patch-sidebar-usage");

const fixture = `let usageAtom;
async function fetchUsage(){return http("/wham/usage")}
function initialize(){usageAtom=query(null,()=>{return{queryFn:()=>fetchUsage(),refetchInterval:()=>30000}})}
function Profile(input){
 const {compact,hideUsage}=input,auth=useAuth();
 const {accountId,authMethod,userId}=auth,width=read(widthAtom),intl=useIntl();
 const label=intl.formatMessage({id:"codex.profileFooter.settingsFallback"});
 const loading=intl.formatMessage({id:"codex.profileFooter.loadingProfile"});
 let picture;picture=authMethod==="chatgpt"?(0,ui.jsx)("span",{children:(0,ui.jsx)(Avatar,{colorKey:userId,name:label,size:"sm",src:null,fallback:null,loadingFallback:null})}):null;
 const icon=picture;let slot;slot=measuring?null:icon;
 const button=(0,ui.jsx)(Button,{compact,uniform:compact,iconSize:"lg","aria-label":label,onClick:openMenu,children:[loading,slot,label]});
 const alternate=(0,ui.jsx)(Alternate,{icon});
 const footer=(0,ui.jsx)(Menu,{sidebarFooter:{width:compact?null:width},hideUsage,triggerButton:button});
 let result;return result=(0,ui.jsx)("footer",{children:footer}),result;
}`;

async function main() {
  const args = process.argv.slice(2);
  let source = fixture, relatedSources = [], rendererPath = path.join(__dirname, "runtime/sidebar-usage.mjs"), origin = "内置功能样本";
  let rendererUrl = pathToFileURL(rendererPath).href;
  if (args[0] === "--assets" && args.length === 2) {
    const assets = path.resolve(args[1]);
    const target = findSidebarTarget(assets);
    source = target.source;
    if (!source.includes("/wham/usage")) {
      const initial = unique(fs.readdirSync(assets).filter(name => /^app-initial-[^/\\]+\.js$/.test(name)), "共享账户额度 Bundle");
      relatedSources = [{ name: initial, source: fs.readFileSync(path.join(assets, initial), "utf8") }];
    }
    origin = `${assets}:${target.name}`;
  } else if (args[0] === "--asar" && args.length === 2) {
    const asar = await import("@electron/asar");
    const files = asar.listPackage(args[1]);
    const candidates = files.filter(name => /app-(?:primary|initial)-[^/\\]+\.js$/.test(name));
    const matches = candidates.map(name => ({ name, source: asar.extractFile(args[1], name.replace(/^[/\\]/, "")).toString() }))
      .filter(file => isSidebarSignature(file.source));
    const entry = unique(matches, "真实侧栏 Bundle");
    source = entry.source;
    if (!source.includes("/wham/usage")) {
      const initial = unique(files.filter(name => /app-initial-[^/\\]+\.js$/.test(name)), "共享账户额度 Bundle");
      relatedSources = [{ name: path.basename(initial), source: asar.extractFile(args[1], initial.replace(/^[/\\]/, "")).toString() }];
    }
    origin = `${args[1]}:${entry.name}`;
    if (source.includes(MARKER)) {
      const embedded = asar.extractFile(args[1], path.join(path.dirname(entry.name), MODULE).replace(/^[/\\]/, "")).toString();
      // Git 在 Windows 构建机可能检出 CRLF；校验源码内容后直接执行成品模块。
      assert.equal(embedded.replace(/\r\n/g, "\n"), fs.readFileSync(rendererPath, "utf8").replace(/\r\n/g, "\n"), "候选渲染模块与当前源码不一致");
      rendererUrl = `data:text/javascript;base64,${Buffer.from(embedded).toString("base64")}`;
    }
  } else assert.equal(args.length, 0, "用法：node scripts/sidebar-usage-smoke.js [--assets PATH | --asar PATH]");
  if (relatedSources.length && !source.includes(MARKER)) {
    const sourceAst = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const linkedImport = unique(sourceAst.body.filter(node => node.type === "ImportDeclaration" &&
      path.basename(node.source.value) === path.basename(relatedSources[0].name)), "测试账户额度导入链");
    const broken = source.slice(0, linkedImport.source.start) + JSON.stringify("./missing-account-usage.js") + source.slice(linkedImport.source.end);
    const rejected = patchSource(broken, { relatedSources });
    assert.equal(rejected.status, "unexpected-shape");
    assert.match(rejected.reason, /账户额度导入链/);
  }
  const result = patchSource(source, { relatedSources });
  assert.ok(["patched", "already-patched"].includes(result.status), result.reason);
  assert.equal(patchSource(result.source).source, result.source, "重复应用必须幂等");
  const ast = parse(result.source, { ecmaVersion: "latest", sourceType: "module" });
  const outer = unique(ast.body.filter(node => node.id?.name === COMPONENT), "账号门槛组件");
  const account = unique(ast.body.filter(node => node.id?.name === ACCOUNT_COMPONENT), "额度组件");
  const declarations = nodes(account, node => node.type === "VariableDeclarator");
  const binding = name => unique(declarations.filter(node => node.id.name === name), name).init;
  const authHook = binding("auth").callee.name, readHook = binding("usage").callee.name;
  const intlHook = binding("intl").callee.name;
  const jsxCall = unique(nodes(outer, node => node.type === "CallExpression" && node.callee.type === "SequenceExpression"), "组件 JSX");
  const jsxName = jsxCall.callee.expressions.at(-1).object.name;
  const atom = {}, fallback = { type: "native-avatar", props: {} }, state = {};
  const jsx = { jsx: (type, props) => typeof type === "function" ? type(props) : { type, props } };
  jsx.jsxs = jsx.jsx;
  const { renderSidebarUsage } = await import(rendererUrl);
  const context = {
    [authHook]: () => state.auth,
    [readHook]: value => { assert.equal(value, atom); state.reads++; return { data: state.usage }; },
    [binding("usage").arguments[0].name]: atom,
    [intlHook]: () => ({ locale: state.locale, formatNumber: (number, options) => new Intl.NumberFormat(state.locale, options).format(number) }),
    [account.body.body[0].expression.callee.name]: () => {},
    [jsxName]: jsx, [RENDER]: renderSidebarUsage,
  };
  const bridgeSource = [outer, account].map(node => result.source.slice(node.start, node.end)).join("\n");
  vm.createContext(context);
  vm.runInContext(bridgeSource, context, { timeout: 2000 });
  const mount = unique(nodes(ast, node => node.type === "CallExpression" &&
    node.arguments[0]?.name === COMPONENT), "真实头像插槽中的额度组件调用");
  const host = unique(ast.body.filter(node => node.type === "FunctionDeclaration" &&
    node.start < mount.start && node.end > mount.end), "侧栏组件宿主");
  const avatarSlot = unique(nodes(host, node => node.type === "VariableDeclarator" && node.init === mount), "头像插槽初始化");
  const nativeButton = unique(nodes(host, node => node.type === "CallExpression" &&
    node.arguments[1]?.type === "ObjectExpression" && ["compact", "uniform", "children"].every(name =>
      node.arguments[1].properties.some(property => property.key?.name === name))), "原生账户菜单按钮");
  const buttonProps = Object.fromEntries(nativeButton.arguments[1].properties.map(property => [property.key.name ?? property.key.value, property.value]));
  const iconAlias = buttonProps.children.elements[1].name;
  const iconForward = unique(nodes(host, node => node.type === "AssignmentExpression" &&
    node.left?.name === iconAlias && node.right.type === "ConditionalExpression" &&
    node.right.alternate?.name === avatarSlot.id.name), "原生按钮继续使用头像插槽");
  assert.ok(iconForward);
  const mountProps = Object.fromEntries(mount.arguments[1].properties.map(property => [property.key.name, property.value.name]));
  const mountSource = result.source.slice(mount.start, mount.end);
  const all = tree => !tree || typeof tree !== "object" ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(all)];
  const render = (compact = true, hidden = false) => {
    state.reads = 0;
    context[mountProps.fallback] = fallback;
    context[mountProps.compact] = compact;
    context[mountProps.hidden] = hidden;
    return vm.runInContext(mountSource, context, { timeout: 2000 });
  };
  const value = tree => all(tree).find(node => node.props?.["data-codex-sidebar-usage-value"])?.props.children;
  const baseAuth = { authMethod: "chatgpt", accountId: "account", userId: "user" };
  const usage = used => ({ account_id: "account", user_id: "user", rate_limit: {
    primary_window: { used_percent: used, limit_window_seconds: 604800, reset_at: 1793000000 },
  } });
  state.auth = baseAuth; state.usage = usage(19); state.locale = "zh-CN";
  let tree = render();
  assert.equal(value(tree), "81"); assert.equal(state.reads, 1);
  assert.equal(tree.props["aria-label"], "剩余额度: 81%");
  assert.equal(tree.type, "span"); assert.equal(tree.props.style.width, 32);
  assert.equal(all(tree).filter(node => node.type === "button").length, 0, "不能在原按钮里嵌套新按钮");
  const ring = all(tree).find(node => node.type === "circle" && node.props.pathLength === 100);
  assert.equal(ring.props.strokeDasharray, "81 100");
  assert.equal(ring.props.strokeWidth, 2);
  assert.match(ring.props.stroke, /^color-mix\(/);
  const track = all(tree).find(node => node.type === "circle" && node.props.pathLength == null);
  assert.equal(track.props.strokeWidth, 2);
  assert.equal(track.props.opacity, 0.1);
  const svg = all(tree).find(node => node.type === "svg");
  assert.equal(svg.props["data-no-autosize"], true, "必须避开官方按钮 SVG 自动缩放");
  assert.equal(svg.props.style.width, tree.props.style.width);
  assert.equal(svg.props.style.height, tree.props.style.height);
  const percentage = all(svg).find(node => node.props?.["data-codex-sidebar-usage-value"]);
  assert.equal(percentage.type, "text", "数字和圆环必须共用 SVG 坐标系");
  assert.equal(percentage.props.x, ring.props.cx);
  assert.equal(percentage.props.y, ring.props.cy);
  assert.equal(percentage.props.textAnchor, "middle");
  assert.equal(percentage.props.dominantBaseline, "central");
  assert.equal(percentage.props.style.fill, "var(--color-text)");
  assert.equal(percentage.props.style.fontWeight, 500);
  assert.ok(percentage.props.style.fontSize >= 13);
  assert.match(tree.props.title, /每周: 81%/);
  for (const node of nodes(nativeButton.arguments[1], node => node.type === "Identifier")) {
    if (!(node.name in context)) context[node.name] = null;
  }
  context[iconAlias] = tree;
  context[nativeButton.arguments[0].name] = props => jsx.jsx("button", props);
  context[buttonProps.onClick.name] = () => { state.menuOpened = true; };
  const button = vm.runInContext(result.source.slice(nativeButton.start, nativeButton.end), context, { timeout: 2000 });
  assert.equal(button.props.children[1], tree);
  button.props.onClick(); assert.equal(state.menuOpened, true, "点击仍走原生账户菜单事件");
  state.usage = usage(28); assert.equal(value(render()), "72", "不打开菜单也应读取最新共享状态");
  tree = render(false); assert.equal(value(tree), "72");
  assert.equal(tree.props.style.width, 24);
  state.usage.rate_limit.secondary_window = { used_percent: 80, limit_window_seconds: 18000 };
  tree = render(); assert.equal(value(tree), "20", "多窗口取最紧张的额度");
  assert.equal(all(tree).find(node => node.type === "circle" && node.props.pathLength === 100).props.stroke, "#bd7b16");
  state.usage = usage(90);
  assert.equal(all(render()).find(node => node.type === "circle" && node.props.pathLength === 100).props.stroke, "#dc503f");
  for (const [used, expected] of [[0, "100"], [100, "0"], [150, "0"], [-1, "100"], [null, "—"]]) {
    state.usage = usage(used); assert.equal(value(render()), expected);
  }
  state.usage = usage(19); state.auth = { ...baseAuth, accountId: "other" };
  assert.equal(value(render()), "—", "切换账号时不能显示旧账号额度");
  state.usage.account_id = "other"; state.usage.rate_limit.primary_window.used_percent = 46;
  assert.equal(value(render()), "54");
  state.auth = { ...baseAuth, isLoading: true }; assert.equal(value(render()), "—");
  state.auth = baseAuth; state.usage = null; assert.equal(value(render()), "—");
  state.usage = usage(19); state.locale = "en-US";
  assert.match(render().props.title, /Weekly: 81%/);
  state.auth = { ...baseAuth, authMethod: "apikey" };
  assert.equal(render(), fallback); assert.equal(state.reads, 0, "API 模式不挂载官方额度订阅");
  state.auth = baseAuth; assert.equal(render(true, true), fallback); assert.equal(state.reads, 0);
  if (source === fixture) {
    const invalid = fixture.replace('"/wham/usage"', '"/changed/usage"');
    assert.equal(patchSource(invalid).status, "unexpected-shape");
    assert.equal(patchSource(invalid).source, invalid);
  }
  console.log(`侧栏额度功能验证通过：${origin}；头像插槽替换、原生菜单点击、常驻更新、未知/边界、双窗口、身份切换。未启动或修改 GUI。`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
