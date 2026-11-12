"use strict";

const { parse } = require("acorn");

function walk(root, visit, { ownScope = false } = {}) {
  function visitNode(node, parent) {
    if (!node || typeof node !== "object" || !node.type) return;
    if (ownScope && node !== root && /Function/.test(node.type)) return;
    visit(node, parent);
    for (const [key, value] of Object.entries(node)) {
      if (["type", "start", "end"].includes(key)) continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visitNode(child, node);
      } else if (value?.type) {
        visitNode(value, node);
      }
    }
  }
  visitNode(root, null);
}

function nodes(root, predicate, options) {
  const found = [];
  walk(root, (node, parent) => {
    if (predicate(node, parent)) found.push(node);
  }, options);
  return found;
}

function literal(node) {
  if (node?.type === "Literal") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return undefined;
}

function key(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  return literal(node) ?? null;
}

function unique(items, label) {
  if (items.length !== 1) throw new Error(`${label} 数量异常（${items.length}）`);
  return items[0];
}

function applyEdits(source, edits) {
  let next = source;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    const replacement = edit.text ?? edit.replacement;
    if (typeof replacement !== "string") throw new Error("AST edit 缺少替换文本");
    next = next.slice(0, edit.start) + replacement + next.slice(edit.end);
  }
  parse(next, { ecmaVersion: "latest", sourceType: "module" });
  return next;
}

module.exports = { applyEdits, key, literal, nodes, unique, walk };
