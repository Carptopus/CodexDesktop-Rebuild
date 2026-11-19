#!/usr/bin/env node
/**
 * 为简体中文推理强度名称补充实际协议参数，并明确 Ultra 的特殊语义。
 *
 * 上游语言包由构建产物生成，文件名包含哈希，直接修改会在下次同步时丢失。
 * 本补丁按稳定的 i18n 消息 ID 定位文本，因此可在每次同步后重复执行。
 *
 * Usage:
 *   node scripts/patch-reasoning-effort-labels.js [platform]
 *   node scripts/patch-reasoning-effort-labels.js --check
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

const { frontendFiles } = require("./rspack-util");
const { nodes } = require("./patch-ast-util");
const PLATFORMS = ["mac-arm64", "mac-x64", "win"];

const TRANSLATION_SPECS = Object.freeze([
  { messageIds: ["composer.mode.local.reasoning.none.label"], translation: "无（none）" },
  { messageIds: ["composer.mode.local.reasoning.minimal.label"], translation: "极低（minimal）" },
  {
    // 26.803 将 low 的消息 ID 升级为 v2；保留旧 ID 以兼容历史安装包。
    messageIds: [
      "composer.mode.local.reasoning.low.label.v2",
      "composer.mode.local.reasoning.low.label",
    ],
    translation: "轻度（low）",
  },
  { messageIds: ["composer.mode.local.reasoning.medium.label"], translation: "中（medium）" },
  { messageIds: ["composer.mode.local.reasoning.high.label"], translation: "高（high）" },
  { messageIds: ["composer.mode.local.reasoning.xhigh.label"], translation: "极高（xhigh）" },
  { messageIds: ["composer.mode.local.reasoning.max.label"], translation: "最高（max）" },
  { messageIds: ["composer.mode.local.reasoning.ultra.label"], translation: "Ultra（ultra）" },
  {
    messageIds: ["composer.modelPicker.power.ultraUsageWarning"],
    translation: "自动任务委派，更快消耗使用额度",
  },
]);

const TRANSLATIONS = Object.freeze(
  Object.fromEntries(
    TRANSLATION_SPECS.map(({ messageIds, translation }) => [messageIds[0], translation]),
  ),
);

function escapeTemplateLiteral(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

function findTemplateLiteralEnd(source, start) {
  for (let index = start; index < source.length; index++) {
    if (source[index] !== "`") continue;

    let backslashes = 0;
    for (let cursor = index - 1; cursor >= start && source[cursor] === "\\"; cursor--) {
      backslashes++;
    }
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

function findOccurrences(source, marker) {
  const indexes = [];
  let offset = 0;
  while ((offset = source.indexOf(marker, offset)) !== -1) {
    indexes.push(offset);
    offset += marker.length;
  }
  return indexes;
}

function patchSource(source) {
  if (source.slice(0, 220).includes("exports=JSON.parse(")) {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const calls = nodes(ast, node => node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" && node.callee.object.name === "JSON" &&
      node.callee.property.name === "parse" && node.arguments[0]?.type === "Literal");
    if (calls.length !== 1) {
      return { status: "unexpected-entry-count", invalidEntries: [{ messageId: "JSON locale", count: calls.length }], source };
    }
    const argument = calls[0].arguments[0], data = JSON.parse(argument.value);
    const patches = [], invalidEntries = [];
    for (const { messageIds, translation } of TRANSLATION_SPECS) {
      const ids = messageIds.filter(id => Object.hasOwn(data, id));
      if (ids.length !== 1) {
        invalidEntries.push({ messageId: messageIds.join(" or "), count: ids.length });
        continue;
      }
      const id = ids[0];
      if (data[id] !== translation) {
        patches.push({ messageId: id, original: data[id], replacement: translation });
        data[id] = translation;
      }
    }
    if (invalidEntries.length) return { status: "unexpected-entry-count", invalidEntries, source };
    if (!patches.length) return { status: "already-patched", patches, source };
    const nextSource = source.slice(0, argument.start) + JSON.stringify(JSON.stringify(data)) + source.slice(argument.end);
    parse(nextSource, { ecmaVersion: "latest", sourceType: "module" });
    return { status: "patched", patches, source: nextSource };
  }
  const patches = [];
  const invalidEntries = [];

  for (const { messageIds, translation } of TRANSLATION_SPECS) {
    const candidates = messageIds.flatMap((messageId) => {
      const marker = `"${messageId}":\``;
      return findOccurrences(source, marker).map((offset) => ({ messageId, marker, offset }));
    });
    if (candidates.length !== 1) {
      invalidEntries.push({ messageId: messageIds.join(" or "), count: candidates.length });
      continue;
    }

    const [{ messageId, marker, offset }] = candidates;
    const start = offset + marker.length;
    const end = findTemplateLiteralEnd(source, start);
    if (end === -1) {
      invalidEntries.push({ messageId, count: 0, unterminated: true });
      continue;
    }

    const replacement = escapeTemplateLiteral(translation);
    const original = source.slice(start, end);
    if (original !== replacement) {
      patches.push({ messageId, start, end, original, replacement });
    }
  }

  if (invalidEntries.length > 0) {
    return {
      status: "unexpected-entry-count",
      invalidEntries,
      source,
    };
  }

  if (patches.length === 0) {
    return { status: "already-patched", patches, source };
  }

  let nextSource = source;
  for (const patch of [...patches].sort((a, b) => b.start - a.start)) {
    nextSource =
      nextSource.slice(0, patch.start) +
      patch.replacement +
      nextSource.slice(patch.end);
  }

  try {
    parse(nextSource, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    return { status: "parse-failed", error, patches, source };
  }

  return { status: "patched", patches, source: nextSource };
}

function getPlatforms(platform) {
  if (platform) return [platform];
  return PLATFORMS.filter((item) =>
    fs.existsSync(path.join(SRC_DIR, item, "_asar", "webview", "assets")),
  );
}

function findTranslationFiles(directory) {
  return frontendFiles(directory).filter(file => {
    if (/^zh-CN-.*\.js$/.test(path.basename(file))) return true;
    const source = fs.readFileSync(file, "utf8");
    return source.slice(0, 220).includes("exports=JSON.parse(") &&
      /"composer\.mode\.local\.reasoning\.none\.label":"无(?:（none）)?"/.test(source.replaceAll('\\"', '"'));
  });
}

function findTargets(platform) {
  const targets = [];
  const invalidPlatforms = [];

  for (const currentPlatform of getPlatforms(platform)) {
    const assetsDir = path.join(
      SRC_DIR,
      currentPlatform,
      "_asar",
      "webview",
      "assets",
    );
    const files = findTranslationFiles(assetsDir);

    if (files.length !== 1) {
      invalidPlatforms.push({ platform: currentPlatform, count: files.length });
      continue;
    }

    targets.push({
      platform: currentPlatform,
      path: files[0],
    });
  }

  return { invalidPlatforms, targets };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((item) => PLATFORMS.includes(item));
  const { invalidPlatforms, targets } = findTargets(platform);
  let failed = invalidPlatforms.length;
  let changed = 0;

  for (const item of invalidPlatforms) {
    console.log(
      `  [x] ${item.platform}: expected 1 zh-CN bundle, found ${item.count}`,
    );
  }

  if (targets.length === 0 && invalidPlatforms.length === 0) {
    console.log("  [skip] No generated platform sources found");
    return;
  }

  for (const target of targets) {
    const source = fs.readFileSync(target.path, "utf-8");
    const result = patchSource(source);
    const label = relPath(target.path);

    if (result.status === "already-patched") {
      console.log(`  [ok] ${label}: already patched`);
      continue;
    }

    if (result.status === "unexpected-entry-count") {
      for (const entry of result.invalidEntries) {
        const reason = entry.unterminated
          ? "unterminated template literal"
          : `expected 1 entry, found ${entry.count}`;
        console.log(`  [x] ${label}: ${entry.messageId}: ${reason}`);
      }
      failed++;
      continue;
    }

    if (result.status === "parse-failed") {
      console.log(`  [x] ${label}: post-patch parse failed: ${result.error.message}`);
      failed++;
      continue;
    }

    if (isCheck) {
      console.log(
        `  [?] ${label}: would update ${result.patches.length} translation(s)`,
      );
    } else {
      fs.writeFileSync(target.path, result.source, "utf-8");
      console.log(
        `  [ok] ${label}: updated ${result.patches.length} translation(s)`,
      );
    }
    changed++;
  }

  console.log(
    `  [done] ${isCheck ? "would patch" : "patched"} ${changed} file(s)`,
  );
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { TRANSLATIONS, TRANSLATION_SPECS, findTranslationFiles, findTargets, patchSource };
