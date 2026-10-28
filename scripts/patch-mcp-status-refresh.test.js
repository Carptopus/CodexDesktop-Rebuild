const test = require("node:test");
const assert = require("node:assert/strict");

const { MARKER, REFRESH_DELAY_MS, patchSource } = require("./patch-mcp-status-refresh");

function fixture() {
  return "function createHandler(e,t,r){let i=!0,C,S=new Set,x;return n=>{switch(n.method){case`mcpServer/startupStatus/updated`:n.params.status===`ready`&&n.params.threadId!=null?C??=setTimeout(()=>{C=void 0,i&&(r?.()??!0)&&(GE(e.queryClient,{queryKey:[...eC,t,`toolsAndAuthOnly`],exact:!0},{cancelRefetch:!1}),GE(e.queryClient,{queryKey:[...eC,t,`mention-discovery`],refetchType:`active`},{cancelRefetch:!1}))},0):n.params.status===`ready`&&GE(e.queryClient,{queryKey:WT,predicate:({queryKey:e})=>(e[1]===`installed-inventory`||e[1]===`installed`&&K_(n.params.name))&&e[2]===t},{cancelRefetch:!1}),n.params.threadId==null&&n.params.status!==`starting`?GE(e.queryClient,{queryKey:[...eC,t]},{cancelRefetch:!1}):n.params.threadId!=null&&n.params.status!==`starting`&&(S.add(n.params.threadId),x??=setTimeout(()=>{x=void 0;let n=S;S=new Set,i&&(r?.()??!0)&&e.queryClient.invalidateQueries({queryKey:[...eC,t,`thread`],predicate:({queryKey:e})=>{let t=e[eC.length+2];return typeof t==`string`&&n.has(t)}})},0));break;default:break}}}";
}

function load(source, calls, timers) {
  const GE = (client, filters, options) => calls.push({ kind: "GE", client, filters, options });
  const setTimeout = (callback, delay) => {
    const timer = { callback, delay };
    timers.push(timer);
    return timer;
  };
  const factory = Function("GE", "eC", "WT", "K_", "setTimeout", `${source};return createHandler`)(
    GE,
    ["mcp"],
    ["plugins"],
    () => true,
    setTimeout,
  );
  const queryClient = {
    invalidateQueries(filters) {
      calls.push({ kind: "invalidate", filters });
    },
  };
  return factory({ queryClient }, "local", () => true);
}

test("启动通知在短窗口内只刷新一次轻量目录并让 Full 仅失效", () => {
  const result = patchSource(fixture());
  assert.equal(result.status, "patched");
  assert.equal(result.source.split(MARKER).length - 1, 1);
  assert.equal(patchSource(result.source).status, "already-patched");

  const calls = [];
  const timers = [];
  const listener = load(result.source, calls, timers);
  const notification = { method: "mcpServer/startupStatus/updated", params: { name: "server-a", status: "ready", threadId: null } };
  listener(notification);
  listener(notification);

  assert.equal(timers.length, 1, "同一窗口内的 global 通知应共享一个轻量刷新定时器");
  assert.equal(timers[0].delay, REFRESH_DELAY_MS);
  assert.equal(calls.filter((item) => item.filters?.queryKey === undefined || item.filters.queryKey?.[0] === "plugins").length, 2,
    "installed inventory 刷新保持上游行为，不属于 Full MCP 目录");

  timers.shift().callback();
  const tools = calls.filter((item) => item.filters?.queryKey?.at(-1) === "toolsAndAuthOnly");
  const mentions = calls.filter((item) => item.filters?.queryKey?.includes("mention-discovery"));
  const full = calls.filter((item) => item.kind === "invalidate" && item.filters?.refetchType === "none");
  assert.equal(tools.length, 1);
  assert.equal(mentions.length, 1);
  assert.equal(full.length, 1);
  assert.deepEqual(full[0].filters.queryKey, ["mcp", "local"]);
  assert.equal(full[0].filters.predicate({ queryKey: ["mcp", "local", "full"] }), true);
  assert.equal(full[0].filters.predicate({ queryKey: ["mcp", "local", "thread", "thread-a", "full"] }), false);
  assert.equal(calls.some((item) => item.filters?.queryKey?.length === 2 && item.options?.cancelRefetch === false), false,
    "不能保留按 host 全量立即 refetch 的 blanket invalidation");
});

test("thread 范围通知仍只失效对应 thread，并与轻量刷新分离", () => {
  const result = patchSource(fixture());
  const calls = [];
  const timers = [];
  const listener = load(result.source, calls, timers);
  listener({ method: "mcpServer/startupStatus/updated", params: { name: "server-a", status: "ready", threadId: "thread-a" } });

  assert.deepEqual(timers.map((item) => item.delay).sort((a, b) => a - b), [0, REFRESH_DELAY_MS]);
  for (const timer of [...timers].sort((a, b) => a.delay - b.delay)) timer.callback();
  const threadInvalidation = calls.find((item) => item.kind === "invalidate" && item.filters?.queryKey?.includes("thread"));
  assert.ok(threadInvalidation);
  assert.equal(threadInvalidation.filters.predicate({ queryKey: ["mcp", "local", "thread", "thread-a", "full"] }), true);
  assert.equal(threadInvalidation.filters.predicate({ queryKey: ["mcp", "local", "thread", "thread-b", "full"] }), false);
});

test("上游刷新结构漂移时明确失败", () => {
  const changed = fixture().replace(
    "GE(e.queryClient,{queryKey:[...eC,t]},{cancelRefetch:!1})",
    "GE(e.queryClient,{queryKey:[...eC,t],refetchType:`active`},{cancelRefetch:!1})",
  );
  const result = patchSource(changed);
  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /blanket/);
});

test("残缺标记明确失败", () => {
  const result = patchSource(fixture() + MARKER);
  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /数量异常|缺失|分支/);
});

test("拆分后的 inventory helper 保持线程累计刷新且不重复刷新 global 库存", () => {
  const source = fixture()
    .replace("let i=!0,C,S=new Set,x;", "let i=!0,C,S=new Set,x,D=!1,O=n=>{GE(e.queryClient,{queryKey:WT,predicate:({queryKey:e})=>(e[1]===`installed-inventory`||e[1]===`installed`&&n)&&e[2]===t},{cancelRefetch:!1})};")
    .replace("?C??=setTimeout(()=>{C=void 0,", "?(D||=K_(n.params.name),C??=setTimeout(()=>{C=void 0;let n=D;D=!1,")
    .replace("exact:!0},{cancelRefetch:!1}),GE", "exact:!0},{cancelRefetch:!1}),O(n),GE")
    .replace("},0):n.params.status===`ready`&&GE(e.queryClient,{queryKey:WT,predicate:({queryKey:e})=>(e[1]===`installed-inventory`||e[1]===`installed`&&K_(n.params.name))&&e[2]===t},{cancelRefetch:!1})",
      "},0)):n.params.status===`ready`&&O(K_(n.params.name))");
  const result = patchSource(source);
  assert.equal(result.status, "patched", result.reason);
  assert.equal(patchSource(result.source).status, "already-patched");
  const calls = [], timers = [], listener = load(result.source, calls, timers);
  const notify = threadId => listener({ method: "mcpServer/startupStatus/updated", params: { threadId, status: "ready", name: "plugin-a" } });
  notify(null); notify(null);
  assert.equal(calls.length, 2);
  timers.shift().callback();
  assert.equal(calls.filter(call => call.filters.queryKey?.[0] === "plugins").length, 2);
  calls.length = 0; notify("thread-a"); notify("thread-b");
  for (const timer of timers.splice(0)) timer.callback();
  assert.equal(calls.filter(call => call.filters.queryKey?.[0] === "plugins").length, 1);
  assert.equal(calls.filter(call => call.filters.queryKey?.at(-1) === "toolsAndAuthOnly").length, 1);
});

test("无关 Bundle 不适用", () => {
  const source = "function unrelated(){return true}";
  const result = patchSource(source);
  assert.equal(result.status, "not-applicable");
  assert.equal(result.source, source);
});

test("26.1021 真实通知函数保留 inventory 并合并轻量目录刷新", { skip: !process.env.CODEX_REBUILD_1021_BUNDLE }, () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const { parse } = require("acorn");
  const { walk, literal } = require("./patch-ast-util");
  let file = process.env.CODEX_REBUILD_1021_BUNDLE;
  if (fs.statSync(file).isDirectory()) {
    const names = fs.readdirSync(file).filter(name => /^initialize-app-host-services-.*\.js$/.test(name) &&
      fs.readFileSync(path.join(file, name), "utf8").includes("toolsAndAuthOnly"));
    assert.equal(names.length, 1); file = path.join(file, names[0]);
  }
  const source = fs.readFileSync(file, "utf8"), result = patchSource(source);
  assert.equal(result.status, "patched", result.reason);
  assert.equal(patchSource(result.source).status, "already-patched");
  const ast = parse(result.source, { ecmaVersion: "latest", sourceType: "module" });
  const branches = [], arrows = [], helpers = [];
  walk(ast, node => {
    if (node.type === "SwitchCase" && literal(node.test) === "mcpServer/startupStatus/updated" &&
        result.source.slice(node.start, node.end).includes(MARKER)) branches.push(node);
    if (node.type === "ArrowFunctionExpression") arrows.push(node);
    if (node.type === "VariableDeclarator" && node.id.name === "O" &&
        result.source.slice(node.start, node.end).includes("installed-inventory")) helpers.push(node);
  });
  assert.equal(branches.length, 1); assert.equal(helpers.length, 1);
  const branch = branches[0];
  const listener = arrows.filter(node => node.start < branch.start && node.end > branch.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  const calls = [], timers = [];
  const context = vm.createContext({
    e: { queryClient: { invalidateQueries: filters => calls.push({ kind: "invalidate", filters }) } },
    t: "local", r: () => true, lh: ["mcp"], Xh: ["plugins"], ea: name => name === "plugin-a",
    eg: (client, filters, options) => calls.push({ kind: "refresh", filters, options }),
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
  });
  vm.runInContext(`let i=true,E,D=false,T=new Set,w,__codexMcpThreadReadyPending=false;let ${result.source.slice(helpers[0].start, helpers[0].end)};globalThis.listener=${result.source.slice(listener.start, listener.end)}`, context);
  const notify = (threadId, status = "ready") => context.listener({ method: "mcpServer/startupStatus/updated", params: { threadId, status, name: "plugin-a" } });
  notify(null); notify(null);
  assert.deepEqual(timers.map(timer => timer.delay), [REFRESH_DELAY_MS]);
  assert.equal(calls.filter(call => call.filters.queryKey?.[0] === "plugins").length, 2);
  timers.shift().callback();
  assert.equal(calls.filter(call => call.filters.queryKey?.[0] === "plugins").length, 2,
    "global 通知不应在延迟回调再次刷新 inventory");
  assert.equal(calls.filter(call => call.filters.queryKey?.at(-1) === "toolsAndAuthOnly").length, 1);
  assert.equal(calls.filter(call => call.filters.queryKey?.at(-1) === "mention-discovery").length, 1);
  const full = calls.find(call => call.filters.refetchType === "none");
  assert.ok(full); assert.equal(full.filters.predicate({ queryKey: ["mcp", "local", "full"] }), true);
  assert.equal(full.filters.predicate({ queryKey: ["mcp", "local", "thread", "thread-a", "full"] }), false);
  calls.length = 0;
  notify("thread-a"); notify("thread-b");
  assert.deepEqual(timers.map(timer => timer.delay).sort((a, b) => a - b), [0, REFRESH_DELAY_MS]);
  for (const timer of timers.splice(0)) timer.callback();
  const inventory = calls.find(call => call.filters.queryKey?.[0] === "plugins");
  assert.ok(inventory); assert.equal(inventory.filters.predicate({ queryKey: ["plugins", "installed", "local"] }), true);
  const thread = calls.find(call => call.kind === "invalidate" && call.filters.queryKey?.includes("thread"));
  assert.ok(thread); assert.equal(thread.filters.predicate({ queryKey: ["mcp", "local", "thread", "thread-a", "full"] }), true);
  assert.equal(thread.filters.predicate({ queryKey: ["mcp", "local", "thread", "other", "full"] }), false);
  calls.length = 0; notify(null, "starting"); assert.equal(timers.length, 0); assert.deepEqual(calls, []);
  notify(null); vm.runInContext("i=false", context); calls.length = 0;
  for (const timer of timers.splice(0)) timer.callback();
  assert.deepEqual(calls, [], "已释放 handler 不继续刷新目录");
  assert.equal(patchSource(source.replace("`installed-inventory`", "`unexpected-inventory`")).status,
    "unexpected-shape", "inventory helper 漂移不能绕过校验");
});
