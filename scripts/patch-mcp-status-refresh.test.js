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

test("无关 Bundle 不适用", () => {
  const source = "function unrelated(){return true}";
  const result = patchSource(source);
  assert.equal(result.status, "not-applicable");
  assert.equal(result.source, source);
});
