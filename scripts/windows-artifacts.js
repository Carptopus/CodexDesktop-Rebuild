const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function validateSource(source) {
  if (source.schemaVersion !== 1 || source.architecture !== "x64"
    || !/^\d+(?:\.\d+){3}$/.test(source.version)
    || source.packageName !== path.basename(source.packageName || "")
    || !/^OpenAI\.Codex_\d+(?:\.\d+){3}_x64__[\w]+\.msix$/.test(source.packageName || "")
    || !source.packageName.startsWith(`OpenAI.Codex_${source.version}_x64__`)
    || !/^[a-f0-9]{64}$/.test(source.sha256 || "")
    || !Number.isSafeInteger(source.size) || source.size <= 0) {
    throw new Error("固定 Windows 来源记录无效，请纠正版本、主包名、架构、大小或 SHA-256");
  }
  return source;
}

async function verifySourceFile(source, file) {
  validateSource(source);
  if (fs.statSync(file).size !== source.size || await sha256(file) !== source.sha256) {
    throw new Error(`官方包内容校验失败，禁止使用缓存：${source.packageName}`);
  }
}

function confinedFile(directory, name) {
  if (!name || path.basename(name) !== name || /[\\/]/.test(name) || name === "." || name === "..") {
    throw new Error("制品文件名必须位于候选目录内");
  }
  return path.join(directory, name);
}

module.exports = { writeJson, sha256, validateSource, verifySourceFile, confinedFile };
