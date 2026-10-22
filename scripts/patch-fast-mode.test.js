const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REQUEST_ACCESS_MARKER,
  SETTINGS_ACCESS_MARKER,
  SETTINGS_AUTH_MARKER,
  patchSource,
} = require("./patch-fast-mode");

function fixture() {
  return [
    "function mapRequirements(value){return value.access}",
    "function useTierAccess(auth,result,pending){",
    "let accountAuth=auth?.authMethod===`chatgpt`||auth?.authMethod===`personalAccessToken`,",
    "method=auth?.authMethod??null,loading=!!auth?.isLoading||accountAuth&&pending,access;",
    "access=accountAuth&&!loading&&result!=null?mapRequirements(result):null;",
    "return{serviceTierAccess:access,isLoading:loading,method}}",
    "async function readTierAccess(context,host){let auth=await context.getAuth(host);",
    "if(auth!==`chatgpt`&&auth!==`personalAccessToken`)return null;",
    "let requirements=await context.getRequirements(host);return mapRequirements(requirements)}",
    "async function readTierForRequest(context,host){try{let access=await readTierAccess(context,host);",
    "return access}catch(error){console.error(`Failed to read service tier for request`,error);return null}}",
  ].join("");
}

function load(source) {
  return Function(`${source};return {useTierAccess,readTierForRequest}`)();
}

test("API-key 设置和请求绕过账户 requirements，同时保持模型档位门槛", async () => {
  const first = patchSource(fixture());

  assert.equal(first.status, "patched");
  assert.ok(first.source.includes(SETTINGS_AUTH_MARKER));
  assert.ok(first.source.includes(SETTINGS_ACCESS_MARKER));
  assert.ok(first.source.includes(REQUEST_ACCESS_MARKER));
  assert.equal(patchSource(first.source).status, "already-patched");

  const runtime = load(first.source);
  assert.deepEqual(runtime.useTierAccess({ authMethod: "apikey" }, null, true), {
    serviceTierAccess: { fast: true, ultrafast: true },
    isLoading: false,
    method: "apikey",
  });
  assert.deepEqual(runtime.useTierAccess({ authMethod: "chatgpt" }, {
    access: { fast: false, ultrafast: true },
  }, false).serviceTierAccess, { fast: false, ultrafast: true });
  assert.equal(runtime.useTierAccess({ authMethod: "copilot" }, null, false).serviceTierAccess, null);

  let accountRequests = 0;
  const context = {
    async getAuth() { return "apikey"; },
    async getRequirements() { accountRequests++; return { access: { fast: false } }; },
  };
  assert.deepEqual(await runtime.readTierForRequest(context, "local"), {
    fast: true,
    ultrafast: true,
  });
  assert.equal(accountRequests, 0);

  const access = runtime.useTierAccess({ authMethod: "apikey" }, null, false).serviceTierAccess;
  const availableOptions = [
    { value: null },
    { value: "fast" },
  ].filter((option) => option.value == null || access[option.value]);
  assert.deepEqual(availableOptions.map((option) => option.value), [null, "fast"]);
  assert.deepEqual([{ value: null }].map((option) => option.value), [null],
    "补丁不为没有 serviceTierOptions 的模型创造 Fast 档位");
});

test("ChatGPT 与 personalAccessToken 继续读取官方账户权限", async () => {
  const runtime = load(patchSource(fixture()).source);
  for (const authMethod of ["chatgpt", "personalAccessToken"]) {
    let accountRequests = 0;
    const context = {
      async getAuth() { return authMethod; },
      async getRequirements() {
        accountRequests++;
        return { access: { fast: false, ultrafast: false } };
      },
    };
    assert.deepEqual(await runtime.readTierForRequest(context, "local"), {
      fast: false,
      ultrafast: false,
    });
    assert.equal(accountRequests, 1);
  }
});

test("无关 fast_mode 字符串不再被误判为速度入口", () => {
  const source = "function homeBeacon(auth){return auth===`chatgpt`&&flags.fast_mode}";
  const result = patchSource(source);

  assert.equal(result.status, "not-applicable");
  assert.equal(result.source, source);
});

test("未知 serviceTierAccess 结构明确失败", () => {
  const source = fixture().replace("accountAuth&&pending", "pending");
  const result = patchSource(source);

  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /设置门槛/);
});

test("残缺补丁标记明确失败", () => {
  const result = patchSource(fixture() + SETTINGS_AUTH_MARKER);

  assert.equal(result.status, "unexpected-shape");
  assert.match(result.reason, /数量异常/);
});

// 明确指定未修改的 26.1016.8120.0 证据；不把大型官方 Bundle 放进公开仓库。
test("26.1016 真实 Bundle 的设置与请求行为", { skip: !process.env.CODEX_REBUILD_1016_BUNDLE }, async () => {
  const fs = require("node:fs");
  const vm = require("node:vm");
  const { parse } = require("acorn");
  const source = fs.readFileSync(process.env.CODEX_REBUILD_1016_BUNDLE, "utf8");
  const result = patchSource(source);
  assert.equal(result.status, "patched", result.reason);
  assert.equal(patchSource(result.source).status, "already-patched");
  const functions = parse(result.source, { ecmaVersion: "latest", sourceType: "module" }).body
    .filter((node) => node.type === "FunctionDeclaration");
  const extract = (name) => {
    const matches = functions.filter((node) => node.id.name === name);
    assert.equal(matches.length, 1);
    return result.source.slice(matches[0].start, matches[0].end);
  };
  let authMethod, pending, requests = 0;
  const access = { fast: false, ultrafast: true };
  const context = vm.createContext({
    vLo: { c: () => [] }, Z: () => "local", vk: {}, OT: () => ({ authMethod, isLoading: false }),
    Nc: () => ({ data: { access }, isPending: pending }), xC: {}, fCe: (value) => value.access,
    Z6s: async () => authMethod, Hwn: async () => { requests++; return { access }; },
  });
  vm.runInContext(`${extract("_Lo")};${extract("t8s")}`, context);
  for (authMethod of ["apikey", "chatgpt", "personalAccessToken", "amazonBedrock", "copilot"]) {
    pending = false;
    const ui = context._Lo();
    const request = await context.t8s({ query: { setData() {} } }, "local");
    const expected = authMethod === "apikey" ? { fast: true, ultrafast: true } : authMethod === "copilot" ? null : access;
    assert.equal(JSON.stringify(ui.serviceTierAccess), JSON.stringify(expected));
    assert.equal(JSON.stringify(request), JSON.stringify(expected));
    pending = true;
    assert.equal(context._Lo().isLoading, ["chatgpt", "personalAccessToken", "amazonBedrock"].includes(authMethod));
  }
  assert.equal(requests, 3, "API-key 与不支持的认证都不读取 requirements");
});
