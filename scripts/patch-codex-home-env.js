#!/usr/bin/env node
/**
 * 确保打包后的 Electron 进程把已解析的 Codex home 写回 CODEX_HOME。
 * 上游启动代码有两类形态：
 *   1. 旧版 main bootstrap 直接 await app-server；
 *   2. 新版 computer-use/native-pipe 启动函数通过 codexHome 参数传递。
 *
 * 如果不补齐环境变量，Windows 子进程可能回退到内置 catalog，
 * 从而忽略用户 ~/.codex 下的配置与 catalog。
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR } = require("./patch-util");

const args = process.argv.slice(2);
const check = args.includes("--check");
const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

const targets = platform
  ? [platform]
  : ["mac-arm64", "mac-x64", "win"].filter((p) =>
      fs.existsSync(path.join(SRC_DIR, p, "_asar", ".vite", "build")),
    );

const LEGACY_OLD = "let j=r.E({moduleDir:__dirname});await Yp(j.codexHome)";
const LEGACY_NEW =
  "let j=r.E({moduleDir:__dirname});process.env.CODEX_HOME??=j.codexHome;await Yp(j.codexHome)";

// 新版上游会把 resolved Codex home 作为 codexHome 参数传入启动函数。
// 函数体一开始补写 process.env.CODEX_HOME，后续 spawn/import 的子进程即可继承。

function countLiteral(src, needle) {
  return src.split(needle).length - 1;
}

function patchSource(src, file) {
  if (src.includes(LEGACY_NEW)) {
    return { matched: true, changed: false, source: src, label: "legacy bootstrap already patched" };
  }
  const legacyCount = countLiteral(src, LEGACY_OLD);
  if (legacyCount > 0) {
    if (legacyCount !== 1) {
      throw new Error(`Expected one legacy Codex home startup marker in ${file}, found ${legacyCount}`);
    }
    return {
      matched: true,
      changed: true,
      source: src.replace(LEGACY_OLD, LEGACY_NEW),
      label: "legacy bootstrap",
    };
  }

  // 新版 Webpack 会将工厂内联为匿名函数；按参数契约识别，不能依赖压缩后的函数名。
  const matches = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (["FunctionDeclaration", "FunctionExpression"].includes(node.type) && node.params.length === 1 && node.params[0].type === "ObjectPattern") {
      const props = Object.fromEntries(node.params[0].properties.filter(p => p.type === "Property").map(p => [p.key.name, p.value]));
      const home = props.codexHome;
      if (home?.type === "AssignmentPattern" && home.left.type === "Identifier" && ["codexCliPath", "platform", "startServer"].every(key => props[key])) {
        const body = src.slice(node.body.start + 1, node.body.end - 1);
        if (!body.includes("windowsHelperPath") || !body.includes("windowsHelperTransportModulePath") || !body.includes("codexHome:")) throw new Error(`Unknown native-pipe startup contract in ${file}`);
        matches.push({ node, home: home.left.name });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value?.type) visit(value);
    }
  }
  visit(parse(src, { ecmaVersion: "latest", sourceType: "module" }));
  if (matches.length > 0) {
    if (matches.length !== 1) {
      throw new Error(`Expected one native-pipe Codex home startup marker in ${file}, found ${matches.length}`);
    }
    const { node, home } = matches[0];
    const injection = `process.env.CODEX_HOME??=${home};`;
    if (src.slice(node.body.start + 1).startsWith(injection)) return { matched: true, changed: false, source: src, label: "native-pipe bootstrap already patched" };
    return {
      matched: true,
      changed: true,
      source: src.slice(0, node.body.start + 1) + injection + src.slice(node.body.start + 1),
      label: "native-pipe bootstrap",
    };
  }

  return { matched: false, changed: false, source: src, label: null };
}

function patchFile(file) {
  const src = fs.readFileSync(file, "utf8");
  const result = patchSource(src, file);
  if (!result.matched) return { matched: false, changed: false };
  if (!result.changed) {
    console.log(`[ok] already patched (${result.label}): ${file}`);
    return { matched: true, changed: false };
  }
  if (check) {
    console.log(`[check] would patch (${result.label}): ${file}`);
    return { matched: true, changed: true };
  }
  fs.writeFileSync(file, result.source, "utf8");
  console.log(`[ok] patched (${result.label}): ${file}`);
  return { matched: true, changed: true };
}

function main() {
  let changed = 0;
  for (const target of targets) {
    const buildDir = path.join(SRC_DIR, target, "_asar", ".vite", "build");
    const files = fs
      .readdirSync(buildDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => path.join(buildDir, name));

    let matched = false;
    for (const file of files) {
      const result = patchFile(file);
      if (!result.matched) continue;
      matched = true;
      if (result.changed) changed++;
    }
    if (!matched) throw new Error(`No Codex home startup marker found for ${target}`);
  }
  console.log(check ? `[check] ${changed} file(s) need patching` : `[done] ${changed} file(s) patched`);
}

if (require.main === module) main();
module.exports = { patchSource };
