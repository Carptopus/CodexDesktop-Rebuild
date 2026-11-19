/** 按真实 Rspack 模块工厂定位前端功能，保留 chunk 注册与依赖加载。 */
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const { key, literal, nodes } = require("./patch-ast-util");

function frontendFiles(directory) {
  // 成品 smoke 从 ASAR 直接读取，复用同一模块图检查且无需解压整个前端。
  if (typeof directory === "object") return directory.files;
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name === "async") files.push(...frontendFiles(file));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(file);
  }
  return files;
}

const readFrontendFile = (directory, file) => typeof directory === "object"
  ? directory.readFile(file) : fs.readFileSync(file, "utf8");

function rspackModules(source) {
  if (!source.includes("export const __webpack_modules__=")) return [];
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const declarations = ast.body.flatMap(node => node.type === "ExportNamedDeclaration"
    && node.declaration?.type === "VariableDeclaration" ? node.declaration.declarations : []);
  const table = declarations.filter(node => node.id.name === "__webpack_modules__");
  if (table.length !== 1 || table[0].init?.type !== "ObjectExpression") {
    throw new Error("Rspack 模块注册表缺失或不唯一");
  }
  return table[0].init.properties.map(property => {
    const factory = property.value;
    if (property.type !== "Property" || factory?.type !== "FunctionExpression"
      || factory.body.type !== "BlockStatement" || factory.params.some(param => param.type !== "Identifier")) {
      throw new Error("Rspack 模块工厂结构未知");
    }
    return { id: String(key(property.key)), factory, start: factory.body.start + 1,
      end: factory.body.end - 1, requireName: factory.params[2]?.name,
      exportsName: factory.params[1]?.name,
      source: source.slice(factory.body.start + 1, factory.body.end - 1) };
  });
}

function isRspackFrontend(directory) {
  return frontendFiles(directory).some(file =>
    readFrontendFile(directory, file).includes("export const __webpack_modules__="));
}

function findFrontendModules(directory, { all = [], any = [], test = () => true } = {}) {
  const matches = source => all.every(value => source.includes(value))
    && (!any.length || any.some(value => source.includes(value)));
  const result = [];
  for (const file of frontendFiles(directory)) {
    const chunkSource = readFrontendFile(directory, file);
    if (!matches(chunkSource) || chunkSource.slice(0, 220).includes("exports=JSON.parse(")) continue;
    for (const module of rspackModules(chunkSource)) {
      if (matches(module.source) && test(module.source, module)) result.push({ ...module, file, chunkSource });
    }
  }
  return result;
}

function replaceFrontendModule(target, source, imports = []) {
  const current = fs.readFileSync(target.file, "utf8");
  if (current !== target.chunkSource) throw new Error(`Rspack 分块在定位后发生变化：${target.file}`);
  const prelude = imports.filter(value => !current.includes(value)).join("\n");
  const result = (prelude ? prelude + "\n" : "")
    + current.slice(0, target.start) + source + current.slice(target.end);
  parse(result, { ecmaVersion: "latest", sourceType: "module" });
  return result;
}

function moduleImports(module) {
  const ast = parse(module.source, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true });
  return nodes(ast, node => node.type === "VariableDeclarator" && node.id.type === "Identifier"
    && node.init?.type === "CallExpression" && node.init.callee.name === module.requireName
    && typeof literal(node.init.arguments[0]) === "string")
    .map(node => ({ local: node.id.name, id: literal(node.init.arguments[0]) }));
}

function findModuleCopies(directory, id) {
  const result = [];
  for (const file of frontendFiles(directory)) {
    const chunkSource = readFrontendFile(directory, file);
    if (!chunkSource.includes(`${id}(`) && !chunkSource.includes(`${JSON.stringify(id)}(`)) continue;
    for (const module of rspackModules(chunkSource)) {
      if (module.id === id) result.push({ ...module, file, chunkSource });
    }
  }
  if (!result.length) throw new Error(`Rspack 依赖模块缺失：${id}`);
  return result;
}

function moduleExports(module) {
  const ast = parse(module.source, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true });
  return nodes(ast, node => node.type === "CallExpression"
    && node.callee.type === "MemberExpression" && node.callee.object.name === module.requireName
    && key(node.callee.property) === "d" && node.arguments[0]?.name === module.exportsName
    && node.arguments[1]?.type === "ObjectExpression")
    .flatMap(node => [node.arguments[1], node.arguments[2]].flatMap((table, index) =>
      table?.type === "ObjectExpression" ? table.properties.map(property => ({
        exported: key(property.key), value: module.source.slice(
          index === 0 && property.value.type === "ArrowFunctionExpression" ? property.value.body.start : property.value.start,
          index === 0 && property.value.type === "ArrowFunctionExpression" ? property.value.body.end : property.value.end),
      })) : []));
}

module.exports = { frontendFiles, rspackModules, isRspackFrontend, findFrontendModules,
  replaceFrontendModule, moduleImports, findModuleCopies, moduleExports };
