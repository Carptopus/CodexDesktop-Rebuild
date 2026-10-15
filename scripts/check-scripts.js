#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const files = fs.readdirSync(__dirname).filter((name) => /\.(?:js|cjs)$/.test(name));
files.push("../forge.config.js");
files.push("runtime/rebuild-test-isolation.cjs");
files.push("runtime/rebuild-test-environment.cjs");
files.push("runtime/reading-width.mjs");
files.push("runtime/accent-presets.mjs");
for (const file of files) execFileSync(process.execPath, ["--check", path.join(__dirname, file)], { stdio: "inherit" });
JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
console.log(`脚本语法检查通过：${files.length} 个文件`);
