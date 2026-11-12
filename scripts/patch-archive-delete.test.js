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

test("新版主进程拆包后单条和批量归档删除均须连接协议", () => {
  const acorn = require("acorn");
  const { hasSplitMainDeleteChain } = require("./patch-archive-delete");
  const main = [
    'async function remove(server,id){return server.sendAppServerRequest("thread/delete",{threadId:id})}',
    'async function batch(server,ids){for(const id of ids)await guard(()=>remove(server,id))}',
    'async function one(server,id){return batch(server,[id])}',
    'async function all(server){return batch(server,await server.listThreads())}',
    'const exported={a:()=>one,b:()=>all};',
  ].join("");
  const service = 'class Archive{async deleteArchivedThread(x){return module.a(x)}async deleteAllArchivedThreads(x){return module.b(x)}}';
  const parse = source => acorn.parse(source, { ecmaVersion: "latest" });
  assert.equal(hasSplitMainDeleteChain(parse(main), parse(service)), true);
  assert.equal(hasSplitMainDeleteChain(parse(main.replace('"thread/delete"', '"thread/archive"')), parse(service)), false);
  assert.equal(hasSplitMainDeleteChain(parse(main), parse(service.replace('module.b(x)', 'module.a(x)'))), false);
  assert.equal(hasSplitMainDeleteChain(parse(main.replace('batch(server,await server.listThreads())', 'noop()')), parse(service)), false);
});


test("新版批量按钮和单条行共用待确认状态", () => {
  const acorn = require("acorn");
  const { inspectRowMutationLink } = require("./patch-archive-delete");
  const source = [
    'function Screen(){const [pending,setPending]=useState(null);',
    'const confirm=()=>{if(pending){setPending(null);mutation.mutate(pending)}};',
    'return ui(Dialog,{onConfirm:confirm,children:[ui(Button,{onClick:()=>setPending({kind:"all"})}),',
    'ui(Group,{onDelete:thread=>setPending({kind:"single",thread})})]})}',
    'function Group(input){const {onDelete:openDelete}=input;return ui(Row,{showDeleteButton:true,onDelete:()=>openDelete(thread)})}',
    'function Row(input){const {showDeleteButton:show,onDelete:remove}=input;if(show)remove()}',
  ].join("");
  function check(text) {
    const ast = acorn.parse(text, { ecmaVersion: "latest" });
    const [screen, , row] = ast.body;
    let props;
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (node.type === "ObjectExpression" && node.properties.some(p => p.key?.name === "showDeleteButton")) props = node;
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value?.type) walk(value);
    }
    walk(ast);
    return inspectRowMutationLink(ast, screen, [row], [props], true).length;
  }
  assert.equal(check(source), 1);
  assert.equal(check(source.replace('setPending({kind:"all"})', 'noop({kind:"all"})')), 0);
});

test("当前归档行通过同一函数对象的别名连接到单条确认状态", () => {
  const acorn = require("acorn");
  const {
    inspectArchiveRowFunctions,
    inspectCurrentArchiveRowLink,
  } = require("./patch-archive-delete");
  const source = [
    'function Screen(){const [pending,setPending]=useState(null);',
    'const mutation={mutate(){}};',
    'const confirm=()=>{if(pending!=null){setPending(null);',
    'mutation.mutate({kind:"single",thread:pending.thread})}};',
    'useDialog({onConfirm:confirm});',
    'const F=e=>setPending({kind:"single",thread:e});const ts=F;',
    'return ui(Group,{onDelete:ts});}',
    'function Group(input){const {onDelete:remove}=input;',
    'return ui(Row,{archivedThread:thread,isDeleteDisabled:false,onDelete:remove});}',
    'function Row(input){const {archivedThread:thread,isDeleteDisabled,onDelete:remove}=input;',
    'return ui("button",{onClick:()=>remove()});}',
  ].join("");
  const ast = acorn.parse(source, { ecmaVersion: "latest" });
  const [screen] = ast.body;
  const rows = inspectArchiveRowFunctions(ast, source, true);
  assert.deepEqual(rows.map((row) => row.id.name), ["Row"]);
  assert.deepEqual(
    inspectCurrentArchiveRowLink(ast, screen, rows).map((row) => row.id.name),
    ["Row"],
  );

  const renamedWithoutAlias = source.replace("const ts=F;", "const ts=other;");
  const missing = acorn.parse(renamedWithoutAlias, { ecmaVersion: "latest" });
  assert.equal(inspectCurrentArchiveRowLink(missing, missing.body[0], rows).length, 0);
});
