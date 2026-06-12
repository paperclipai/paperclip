import { parse } from "@babel/parser";
import _traverse, { type NodePath, type TraverseOptions } from "@babel/traverse";
import type { Node, JSXText, JSXAttribute } from "@babel/types";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

// @babel/traverse ships as CJS; under NodeNext + esModuleInterop the default
// import can surface as a namespace object whose callable lives on `.default`.
// Normalize to the callable and pin a minimal call signature so it typechecks
// regardless of how the module's default export is resolved.
type TraverseFn = (parent: Node, opts: TraverseOptions) => void;
const traverseRaw = _traverse as unknown as { default?: unknown };
const traverse = (traverseRaw.default ?? _traverse) as TraverseFn;

const ATTR_PROPS = new Set(["placeholder", "title", "aria-label", "label"]);

export interface Extracted {
  text: string[];
  attr: string[];
}

export function extractStrings(code: string): Extracted {
  const ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const text = new Set<string>();
  const attr = new Set<string>();
  traverse(ast, {
    JSXText(path: NodePath<JSXText>) {
      const v = path.node.value.replace(/\s+/g, " ").trim();
      if (v) text.add(v);
    },
    JSXAttribute(path: NodePath<JSXAttribute>) {
      const name = String(path.node.name.name);
      if (!ATTR_PROPS.has(name)) return;
      const val = path.node.value;
      if (val && val.type === "StringLiteral" && val.value.trim()) attr.add(val.value.trim());
    },
  });
  return { text: [...text], attr: [...attr] };
}

export interface Dict {
  $meta?: unknown;
  text: Record<string, string>;
  attr: Record<string, string>;
}

export function mergeInto(existing: Dict, found: Extracted): Dict {
  const out: Dict = { ...existing, text: { ...existing.text }, attr: { ...existing.attr } };
  for (const k of found.text) if (!(k in out.text)) out.text[k] = "";
  for (const k of found.attr) if (!(k in out.attr)) out.attr[k] = "";
  return out;
}

// Recursively collect all *.tsx files under a directory (Node 20+ compatible;
// avoids globSync which only exists in Node 22+).
function collectTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsx(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".tsx") &&
      !entry.name.includes(".test.") &&
      !entry.name.includes(".stories.")
    ) {
      out.push(full);
    }
  }
  return out;
}

// CLI entry: harvest ui/src and merge into src/dictionary/de.json
function main(): void {
  const uiRoot = fileURLToPath(new URL("../../../../ui/src/", import.meta.url));
  if (!existsSync(uiRoot)) {
    console.error(`harvest: UI source dir not found: ${uiRoot}`);
    console.error("This tool only runs on a dev checkout where ui/src/**/*.tsx exists.");
    process.exit(1);
  }

  const files = collectTsx(uiRoot);
  const found: Extracted = { text: [], attr: [] };
  const text = new Set<string>();
  const attr = new Set<string>();

  for (const file of files) {
    try {
      const code = readFileSync(file, "utf8");
      const { text: t, attr: a } = extractStrings(code);
      for (const s of t) text.add(s);
      for (const s of a) attr.add(s);
    } catch (err) {
      console.warn(`harvest: skipped ${file}: ${(err as Error).message}`);
    }
  }
  found.text = [...text];
  found.attr = [...attr];

  const dictUrl = new URL("../src/dictionary/de.json", import.meta.url);
  const dictPath = fileURLToPath(dictUrl);
  const existing: Dict = JSON.parse(readFileSync(dictPath, "utf8"));
  const merged = mergeInto(existing, found);

  writeFileSync(dictPath, JSON.stringify(merged, null, 2) + "\n", "utf8");

  const untranslated =
    Object.values(merged.text).filter((v) => v === "").length +
    Object.values(merged.attr).filter((v) => v === "").length;
  console.log(`Harvested ${files.length} files; ${untranslated} untranslated keys remain.`);
}

// Run main() only when invoked directly (not when imported by the tests).
// Build the entry URL via pathToFileURL so percent-encoding (e.g. spaces in
// the path) and relative argv[1] values match import.meta.url reliably.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) main();
