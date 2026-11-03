/**
 * Shared utilities for patch scripts.
 * Provides multi-platform bundle location and common helpers.
 */
const fs = require("fs");
const path = require("path");

const SRC_DIR = process.env.CODEX_PATCH_SOURCE_DIR
  ? path.resolve(process.env.CODEX_PATCH_SOURCE_DIR)
  : path.join(__dirname, "..", "src");
const PROJECT_ROOT = path.join(__dirname, "..");

/**
 * Locate bundles matching a filename pattern across platform directories.
 *
 * @param {object} opts
 * @param {"build"|"assets"} opts.dir - Subdirectory type:
 *   "build"  -> src/{plat}/.vite/build/
 *   "assets" -> src/{plat}/webview/assets/
 * @param {RegExp} opts.pattern - Filename regex (e.g. /^index-.*\.js$/)
 * @param {string} [opts.platform] - Restrict to a single platform
 * @returns {Array<{platform: string, path: string}>}
 */
function locateBundles({ dir, pattern, platform }) {
  const dirMap = {
    build: (plat) => path.join(SRC_DIR, plat, "_asar", ".vite", "build"),
    assets: (plat) => path.join(SRC_DIR, plat, "_asar", "webview", "assets"),
  };

  // Legacy fallback paths (flat src/ without _asar subdirs)
  const legacyMap = {
    build: path.join(SRC_DIR, ".vite", "build"),
    assets: path.join(SRC_DIR, "webview", "assets"),
  };

  const getDir = dirMap[dir];
  if (!getDir) throw new Error(`Unknown dir type: ${dir}`);

  const ALL_PLATFORMS = ["mac-arm64", "mac-x64", "win"];
  const platforms = platform
    ? [platform]
    : ALL_PLATFORMS.filter((p) => fs.existsSync(getDir(p)));

  // Legacy fallback
  if (platforms.length === 0) {
    const fallback = legacyMap[dir];
    if (fallback && fs.existsSync(fallback)) {
      const files = fs.readdirSync(fallback).filter((f) => pattern.test(f));
      if (files.length > 0) {
        // For build dir, prefer hashed file over plain
        const target =
          files.length > 1 ? files.find((f) => f !== "main.js") || files[0] : files[0];
        return [{ platform: "legacy", path: path.join(fallback, target) }];
      }
    }
    return [];
  }

  const results = [];
  for (const plat of platforms) {
    const d = getDir(plat);
    if (!fs.existsSync(d)) continue;

    const files = fs.readdirSync(d).filter((f) => pattern.test(f));
    if (files.length === 0) {
      console.warn(`  [!] ${plat}: no match for ${pattern}`);
      continue;
    }

    // For build dir with multiple matches, prefer hashed variant
    const target =
      files.length > 1 ? files.find((f) => f !== "main.js") || files[0] : files[0];

    results.push({ platform: plat, path: path.join(d, target) });
  }

  return results;
}

/**
 * Return path relative to project root.
 */
function relPath(absPath) {
  return path.relative(PROJECT_ROOT, absPath);
}

// 主进程已拆成 Webpack 数值 chunk；按功能锚点定位，不能任选文件名首项。
function listBuildBundles(platform) {
  const roots = platform ? [platform] : ["mac-arm64", "mac-x64", "win"];
  const dirs = roots.map((p) => ({ platform: p, path: path.join(SRC_DIR, p, "_asar", ".vite", "build") }))
    .filter((entry) => fs.existsSync(entry.path));
  if (!platform && dirs.length === 0) {
    const legacy = path.join(SRC_DIR, ".vite", "build");
    if (fs.existsSync(legacy)) dirs.push({ platform: "legacy", path: legacy });
  }
  return dirs.flatMap((entry) => fs.readdirSync(entry.path).filter((name) => name.endsWith(".js"))
    .map((name) => ({ platform: entry.platform, path: path.join(entry.path, name) })));
}

function locateBuildFeatureBundles({ platform, label, match }) {
  const candidates = listBuildBundles(platform);
  if (candidates.length === 0) throw new Error(`${label}: no build bundles found`);
  return [...new Set(candidates.map((entry) => entry.platform))].map((current) => {
    const matches = candidates.filter((entry) => entry.platform === current && match(fs.readFileSync(entry.path, "utf8")));
    if (matches.length !== 1) throw new Error(`${label}: ${current}: expected exactly 1 functional bundle, found ${matches.length}`);
    return matches[0];
  });
}

module.exports = { locateBundles, listBuildBundles, locateBuildFeatureBundles, relPath, SRC_DIR, PROJECT_ROOT };
