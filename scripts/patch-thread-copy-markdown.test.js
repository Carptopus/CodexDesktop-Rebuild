const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const vm = require("node:vm");
const { parse } = require("acorn");
const { ERROR_ID, MARKER, patchSource, validatePatched } = require("./patch-thread-copy-markdown");

const nativeFixture = "async function getComplete(client,id){if(!client)throw Error('Conversation must be resumed before loading history');let result=complete(client.getConversation(id));return result}" +
  "async function renderNative({visibleTurnEntries,cwd,title}){return renderConversationMarkdown(visibleTurnEntries,cwd,title)}" +
  "function visibleNative({conversationRequests,conversationTurns,hasConversation,parentConversationTurns,subagentParentThreadId}){return{visibleTurnEntries:conversationTurns}}" +
  "async function readView(scope,{conversationId,isBackgroundSubagentsEnabled,markdownLimit}){if(excluded(scope.source))return null;let {visibleTurnEntries}=scope.get(conversationId);return renderNative({visibleTurnEntries})}";
const fixture = nativeFixture + "function copy({scope:s,conversationId:id,parentConversationId:parent,getMarkdown:render,intl:i}){" +
  "(async()=>{await manager(s,s.get(host,id)).ensureConversationHistoryLoaded(id,parent==null?[]:[parent]);" +
  "let markdown=await render();markdown!=null&&markdown.trim().length!==0&&await write(markdown)&&" +
  "s.get(toasts).success(i.formatMessage(messages.copyConversationMarkdownSuccess))})().catch(()=>{" +
  `s.get(toasts).danger(i.formatMessage(messages.copyConversationMarkdownError),{errorAnalytics:{toastId:'${ERROR_ID}'}})})}`;

function compile({ content = "# 会话\n实际历史", clipboard = true, failure, viewLoaded = false, source = "user", parentMissing = false } = {}) {
  const result = patchSource(fixture);
  assert.equal(result.status, "patched");
  const calls = [];
  const written = [];
  const notices = [];
  let loaded = false;
  const client = {
    async getConversation(id) {
      if (parentMissing && id === "parent-thread") return null;
      return { content, threadSource: source, requests: [], complete: loaded && failure !== "incomplete" };
    },
    async ensureConversationHistoryLoaded(id, parents, options) {
      calls.push({ id, parents, options });
      if (failure === "history") throw Error("读取历史失败");
      if (options?.force) loaded = true;
    },
  };
  const notify = { success: (value) => notices.push(["success", value]), danger: (value) => notices.push(["danger", value]) };
  const scope = { get: (token) => token === "toasts" ? notify : "local" };
  const copy = vm.runInNewContext(`${result.source};copy`, {
    host: "host", toasts: "toasts", manager: () => client,
    messages: { copyConversationMarkdownSuccess: "复制成功", copyConversationMarkdownError: "复制失败" },
    write: async (text) => {
      if (failure === "clipboard") throw Error("剪贴板占用");
      if (clipboard) written.push(text);
      return clipboard;
    },
    complete: (conversation) => conversation?.complete ? [conversation.content] : null,
    excluded: (value) => value === "unsupported",
    renderConversationMarkdown: (entries) => entries[0],
  });
  const run = (parent) => copy({ scope, conversationId: "thread", parentConversationId: parent,
    getMarkdown: async () => {
      if (failure === "render") throw Error("格式化失败");
      return loaded && viewLoaded ? content : null;
    }, intl: { formatMessage: (value) => value } });
  return { run, calls, written, notices };
}

test("冷会话复制强制加载完整历史，再写入内容并提示成功", async () => {
  const h = compile();
  await h.run();
  assert.equal(h.calls[0].options.force, true);
  assert.equal(h.calls[0].id, "thread");
  assert.deepEqual(h.written, ["# 会话\n实际历史"]);
  assert.deepEqual(h.notices, [["success", "复制成功"]]);
});

test("子代理复制保留父会话加载并读取", async () => {
  const h = compile();
  await h.run("parent-thread");
  assert.deepEqual([...h.calls[0].parents], ["parent-thread"]);
  assert.deepEqual(h.notices, [["success", "复制成功"]]);
});

test("已打开页面继续使用官方 Markdown 回调", async () => {
  const h = compile({ viewLoaded: true });
  await h.run();
  assert.deepEqual(h.written, ["# 会话\n实际历史"]);
});

test("后台历史不完整或父会话快照缺失时拒绝复制", async () => {
  const incomplete = compile({ failure: "incomplete" });
  await incomplete.run();
  assert.deepEqual(incomplete.written, []);
  assert.deepEqual(incomplete.notices, [["danger", "复制失败"]]);

  const missing = compile({ parentMissing: true });
  await missing.run("parent-thread");
  assert.deepEqual(missing.written, []);
  assert.deepEqual(missing.notices, [["danger", "复制失败"]]);
});

test("不支持的会话类型走原生错误提示", async () => {
  const h = compile({ source: "unsupported" });
  await h.run();
  assert.deepEqual(h.written, []);
  assert.deepEqual(h.notices, [["danger", "复制失败"]]);
});

for (const content of [null, "", " \n "]) {
  test(`空 Markdown ${JSON.stringify(content)} 不写剪贴板并提示失败`, async () => {
    const h = compile({ content });
    await h.run();
    assert.deepEqual(h.written, []);
    assert.deepEqual(h.notices, [["danger", "复制失败"]]);
  });
}

for (const failure of ["history", "render", "clipboard"]) {
  test(`${failure} 失败沿用原生错误提示`, async () => {
    const h = compile({ failure });
    await h.run();
    assert.deepEqual(h.written, []);
    assert.deepEqual(h.notices, [["danger", "复制失败"]]);
  });
}

test("剪贴板写入返回 false 时提示失败", async () => {
  const h = compile({ clipboard: false });
  await h.run();
  assert.deepEqual(h.written, []);
  assert.deepEqual(h.notices, [["danger", "复制失败"]]);
});

test("补丁幂等且保留复制动作之外的加载调用", () => {
  const unrelated = "function unrelated(){return client.ensureConversationHistoryLoaded(id,[])}";
  const first = patchSource(fixture + unrelated);
  const second = patchSource(first.source);
  assert.equal(second.status, "already-patched");
  assert.equal(second.source, first.source);
  assert.ok(first.source.endsWith(unrelated));
});

test("结构漂移、重复复制动作和缺少原生 helper 均 fail-closed", () => {
  const changed = fixture.replace("ensureConversationHistoryLoaded(id,", "differentHistoryLoader(id,");
  assert.equal(patchSource(changed).status, "unsupported-copy-structure");
  const duplicate = fixture + fixture.slice(nativeFixture.length).replace("function copy(", "function duplicateCopy(");
  assert.equal(patchSource(duplicate).status, "ambiguous-copy-action");
  assert.equal(patchSource(fixture.replace("renderConversationMarkdown(visibleTurnEntries", "changedRenderer(visibleTurnEntries")).status,
    "unsupported-history-renderer");
  assert.equal(patchSource(fixture.replace(ERROR_ID, "missing.error.signature")).status, "signature-missing");
});

test("已有标记必须通过补丁后结构验证", () => {
  const damaged = fixture.replace("function copy(", `function copy(){${MARKER};function copy(`);
  assert.equal(patchSource(damaged).status, "unexpected-shape");
  assert.throws(() => validatePatched(`${MARKER} broken`));
});

test("check 模式定位单一原生入口，未改变输入内容", () => {
  const before = fixture;
  const result = patchSource(before);
  assert.equal(result.status, "patched");
  assert.equal(fixture, before);
  assert.equal(patchSource(result.source).status, "already-patched");
});

test("CLI 按 check、apply、check 执行且拒绝重复源码签名", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-copy-markdown-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "win", "_asar", "webview", "assets");
  fs.mkdirSync(assets, { recursive: true });
  const target = path.join(assets, "app-primary-test.js");
  fs.writeFileSync(target, fixture);
  const script = path.join(__dirname, "patch-thread-copy-markdown.js");
  const check = spawnSync(process.execPath, [script, "win", "--check"], {
    encoding: "utf8", env: { ...process.env, CODEX_PATCH_SOURCE_DIR: root },
  });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /check only; no write/);
  assert.equal(fs.readFileSync(target, "utf8"), fixture);

  const apply = spawnSync(process.execPath, [script, "win"], {
    encoding: "utf8", env: { ...process.env, CODEX_PATCH_SOURCE_DIR: root },
  });
  assert.equal(apply.status, 0, apply.stderr);
  const applied = fs.readFileSync(target, "utf8");
  assert.notEqual(applied, fixture);
  assert.equal(patchSource(applied).status, "already-patched");

  const secondCheck = spawnSync(process.execPath, [script, "win", "--check"], {
    encoding: "utf8", env: { ...process.env, CODEX_PATCH_SOURCE_DIR: root },
  });
  assert.equal(secondCheck.status, 0, secondCheck.stderr);
  assert.equal(fs.readFileSync(target, "utf8"), applied);

  fs.writeFileSync(path.join(assets, "app-initial-duplicate.js"), fixture);
  const duplicate = spawnSync(process.execPath, [script, "win", "--check"], {
    encoding: "utf8", env: { ...process.env, CODEX_PATCH_SOURCE_DIR: root },
  });
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /复制动作源码签名.*数量异常（2）/);
});

// 本场景固定验证 26.1016 的真实 renderer/helper 名称；ASAR 版本变化时需重新适配 fixture。
test("26.1016 真实 ASAR 的复制函数执行冷快照与失败路径", { skip: !process.env.CODEX_PATCH_REAL_ASAR }, async () => {
  const asar = require("@electron/asar");
  const crypto = require("node:crypto");
  const archive = path.resolve(process.env.CODEX_PATCH_REAL_ASAR);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"),
    "8563a16801cccb9b3feb02a9a18052f4e6d1b2eb271827a44228d22deae99700");
  const entry = asar.listPackage(archive).find((file) => file.includes("app-initial-") && file.endsWith(".js"));
  assert.ok(entry, "ASAR 缺少 app-initial JavaScript");
  const source = asar.extractFile(archive, entry.slice(1)).toString("utf8");
  const patched = patchSource(source);
  assert.ok(["patched", "already-patched"].includes(patched.status), patched.reason || patched.status);
  validatePatched(patched.source);

  const ast = parse(patched.source, { ecmaVersion: "latest", sourceType: "module" });
  const functions = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "FunctionDeclaration" && patched.source.slice(node.start, node.end).includes(MARKER)) functions.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value?.type) visit(value);
    }
  };
  visit(ast);
  assert.equal(functions.length, 1);
  const fnNode = functions[0];
  const fnSource = patched.source.slice(fnNode.start, fnNode.end);
  const parameters = Object.fromEntries(fnNode.params[0].properties.map((property) => [property.key.name, property.value.name]));
  const execute = async ({ incomplete = false, empty = false, writeFails = false, parent = null } = {}) => {
    let loaded = false; const reads = []; const writes = []; const notices = [];
    const client = {
      async ensureConversationHistoryLoaded(id, parents, options) { assert.equal(options.force, true); loaded = true; reads.push(...parents); },
      async getConversation(id) {
        reads.push(id);
        return id === parent && parent ? { threadSource: "user", turns: ["parent"] } :
          { threadSource: "user", requests: [], turns: incomplete ? null : ["cold session"], cwd: "C:\\repo", title: "Cold", projectlessOutputDirectory: null };
      },
    };
    const scope = { get: (token) => token === "toasts" ? { success: (value) => notices.push(["success", value]), danger: (value) => notices.push(["danger", value]) } : client };
    const context = {
      yk: "host", nl: "toasts", mY: { copyConversationMarkdownSuccess: "ok", copyConversationMarkdownError: "error" },
      gh: (_scope, value) => value, VSo: () => false,
      _4t: (snapshot) => snapshot?.turns ?? null,
      vCo: ({ conversationTurns, parentConversationTurns }) => ({ visibleTurnEntries: [...parentConversationTurns, ...conversationTurns] }),
      HCo: async ({ visibleTurnEntries }) => empty ? "   " : visibleTurnEntries.join("\n"),
      Vi: async (value) => { if (writeFails) return false; writes.push(value); return true; },
    };
    const run = vm.runInNewContext(`(${fnSource})`, context);
    await run({ scope, conversationId: "thread", parentConversationId: parent,
      getMarkdown: async () => null, intl: { formatMessage: (value) => value } });
    return { loaded, reads, writes, notices };
  };
  const cold = await execute();
  assert.equal(cold.loaded, true);
  assert.deepEqual(cold.writes, ["cold session"]);
  assert.deepEqual(cold.notices, [["success", "ok"]]);
  const parentResult = await execute({ parent: "parent-thread" });
  assert.ok(parentResult.reads.includes("parent-thread"));
  const incomplete = await execute({ incomplete: true });
  assert.deepEqual(incomplete.writes, []);
  assert.deepEqual(incomplete.notices, [["danger", "error"]]);
  const emptyResult = await execute({ empty: true });
  assert.deepEqual(emptyResult.writes, []);
  assert.deepEqual(emptyResult.notices, [["danger", "error"]]);
  const writeFailure = await execute({ writeFails: true });
  assert.deepEqual(writeFailure.notices, [["danger", "error"]]);
});
