const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeArchivedListProviders,
  patchArchivedListProviders,
} = require("./patch-archive-delete");

test("归档分页会返回其他 Provider 的历史会话", async () => {
  const source = "async function list(client,cursor){return client.sendRequest(`thread/list`,{archived:!0,cursor,limit:100,modelProviders:null,sourceKinds:[`vscode`],useStateDbOnly:!0})}";
  const threads = [
    { id: "old", provider: "local" },
    { id: "new", provider: "custom" },
  ];
  const calls = [];
  const client = {
    async sendRequest(method, options) {
      calls.push({ method, options });
      const providers = options.modelProviders ?? ["custom"];
      return {
        data: threads.filter(
          (thread) => providers.length === 0 || providers.includes(thread.provider),
        ),
      };
    },
  };

  const original = new Function(`${source};return list`)();
  assert.deepEqual(
    (await original(client, "next")).data.map((thread) => thread.id),
    ["new"],
  );

  const patchedSource = patchArchivedListProviders(source);
  const patched = new Function(`${patchedSource};return list`)();
  assert.deepEqual(
    (await patched(client, "next")).data.map((thread) => thread.id),
    ["old", "new"],
  );
  assert.deepEqual(calls[1], {
    method: "thread/list",
    options: {
      archived: true,
      cursor: "next",
      limit: 100,
      modelProviders: [],
      sourceKinds: ["vscode"],
      useStateDbOnly: true,
    },
  });
  assert.equal(patchArchivedListProviders(patchedSource), patchedSource);
});

test("归档 Provider 修复不改变活动列表、显式过滤和其他调用", () => {
  const unchanged = [
    'client.sendRequest("thread/list",{archived:false,modelProviders:null});',
    'client.sendRequest("thread/list",{modelProviders:null});',
    'client.sendRequest("thread/list",{archived:true,modelProviders:["custom"]});',
    'client.sendRequest("thread/delete",{archived:true,modelProviders:null});',
    'client.unrelated({archived:true,modelProviders:null});',
    'const text="modelProviders:null,archived:!0";',
  ].join("");
  const queries = [
    "client.listAllThreads({modelProviders:null,archived:!0});",
    'client["sendRequest"]("thread/list",{"archived":true,"modelProviders":null});',
  ].join("");
  const expected = unchanged + [
    "client.listAllThreads({modelProviders:[],archived:!0});",
    'client["sendRequest"]("thread/list",{"archived":true,"modelProviders":[]});',
  ].join("");

  const result = analyzeArchivedListProviders(unchanged + queries);
  assert.equal(result.code, expected);
  assert.equal(result.edits, 2);
  assert.equal(result.alreadyAllProviders, 0);

  const repeated = analyzeArchivedListProviders(result.code);
  assert.equal(repeated.code, expected);
  assert.equal(repeated.edits, 0);
  assert.equal(repeated.alreadyAllProviders, 2);
});
