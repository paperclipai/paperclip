// Fingerprints the contracts that cross the Runner/provider-pack boundary from
// semantic artifacts (schemas, parser allowlists, exported type shapes, env key
// sets, serde shapes) instead of source bytes. Comments, formatting and
// function-body refactors do not change a fingerprint; a new field, accepted
// value or env key does. build-provider-pack.mjs records the combined digest so
// an image pack is reused only by a controller built from the same contracts.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as babel from "@babel/parser";

const R = "packages/paperclip-runner";
const RUST = `${R}/runner/crates/runner-core/src`;
const DOC_KEYS = new Set(["description", "title", "$comment", "examples", "markdownDescription"]);
const SCHEMA_ID = /^paperclip\.[\w.-]+\.v\d+$/;

/** Contract registry. Each contract binds probes; a probe reads one artifact.
 * Only trees present in every pack build context are read (Docker contexts
 * exclude tests, fixtures and docs), so the digest is the same wherever a pack
 * is built. Registration is by directory where possible; hand-registered files
 * hold boundary contracts outside those directories. */
export const CONTRACTS = [
  { id: "prp.schemas", expand: { kind: "json-dir", dirs: [`${R}/protocol/schemas`, `${R}/protocol/provider-schemas`] } },
  { id: "completion-continuation", probes: [
    { kind: "ts-allowlists", path: `${R}/src/drivers/completion-continuation.ts`, functions: /./ },
  ] },
  { id: "acpx-admission-errors", probes: [
    { kind: "ts-const", path: `${R}/src/drivers/acpx/admission-diagnostics.ts` },
  ] },
  { id: "acpx-permission-policy", probes: [
    { kind: "ts-const", path: `${R}/src/drivers/acpx/permission-policy.ts` },
  ] },
  { id: "launch-requirements", probes: [
    { kind: "ts-types", path: `${R}/src/live/runner-provider-launch.ts`, exported: true },
    { kind: "schema-ids", path: `${R}/src/live/runner-provider-launch.ts` },
  ] },
  { id: "launch-preparation-store", probes: [
    { kind: "ts-types", path: `${R}/src/live/runner-launch-preparation-store.ts` },
    { kind: "schema-ids", path: `${R}/src/live/runner-launch-preparation-store.ts` },
  ] },
  { id: "configured-environment", probes: [
    { kind: "ts-const", path: `${R}/src/configured-environment.ts` },
    { kind: "ts-const", path: `${R}/src/drivers/acpx/environment.ts` },
    { kind: "rust-consts", path: `${RUST}/configured_environment.rs` },
  ] },
  { id: "durable-control-plane", probes: [
    { kind: "ts-const", path: `${R}/src/control-plane/durable-prp-control-plane.ts` },
    { kind: "ts-allowlists", path: `${R}/src/control-plane/durable-prp-control-plane.ts`, functions: /./ },
  ] },
  { id: "acpx-sidecar-input", probes: [
    { kind: "ts-allowlists", path: `${R}/src/cli/acpx-runtime-sidecar.ts`, functions: /^parse/ },
    { kind: "ts-allowlists", path: `${R}/src/cli/acpx-sidecar-input.ts`, functions: /./ },
    { kind: "ts-const", path: `${R}/src/drivers/acpx/generated-sidecar-contract.ts` },
  ] },
  { id: "semantic-tool-receipt", probes: [
    { kind: "ts-const", path: `${R}/src/drivers/semantic-tool-receipt.ts` },
    { kind: "ts-types", path: `${R}/src/drivers/semantic-tool-receipt.ts`, exported: true },
  ] },
  // Prompt and tool description text is model-visible, not a peer contract.
  { id: "ts.contracts", expand: { dirs: [`${R}/src/contracts`], suffix: ".ts", exclude: /\.test\.ts$|runtime-context-prompts\.ts$/, idPrefix: "ts.contracts.", probes: [
    { kind: "ts-types", exported: true },
    { kind: "ts-const", exportedOnly: true, stripDocs: true, exclude: /PROMPT|_DESCRIPTION$/ },
    { kind: "ts-allowlists", functions: /./ },
    { kind: "schema-ids" },
  ] } },
  { id: "rust", expand: { dirs: [RUST], suffix: ".rs", idPrefix: "rust.", probes: [
    { kind: "rust-serde" }, { kind: "rust-json-keys" }, { kind: "rust-match-literals" }, { kind: "rust-env-keys" },
  ] } },
  { id: "generated", expand: { dirs: [`${R}/generated`], suffix: ".json", idPrefix: "generated.", probes: [{ kind: "json", stripDocs: true }] } },
];

/** Every hand-registered file a probe reads. */
export function probePaths() {
  return CONTRACTS.flatMap(c => c.probes ?? []).map(p => p.path);
}
export function expandDirs() {
  return CONTRACTS.flatMap(c => c.expand?.dirs ?? []);
}

/**
 * @param {(path: string) => string | null} readFile repository-relative path
 * @param {(dir: string) => string[]} listDir repository-relative file paths under dir
 * @returns {Record<string, { fingerprint: string, value: unknown }>}
 */
export function fingerprintContracts(readFile, listDir) {
  const out = {};
  for (const contract of CONTRACTS) {
    if (contract.expand?.kind === "json-dir") {
      for (const path of contract.expand.dirs.flatMap(listDir).filter(p => p.endsWith(".json")).sort()) {
        const value = probe({ kind: "json", path, stripDocs: true }, readFile);
        out[`prp.${path.split("/").pop().replace(/\.schema\.json$|\.json$/, "")}`] = { fingerprint: digest(value), value };
      }
      continue;
    }
    if (contract.expand) {
      const { dirs, suffix, exclude, idPrefix, probes } = contract.expand;
      for (const path of dirs.flatMap(listDir).filter(p => p.endsWith(suffix) && !exclude?.test(p)).sort()) {
        const value = probes.map(p => probe({ ...p, path }, readFile));
        if (isEmpty(value)) continue;
        const id = idPrefix + path.slice(dirs.find(d => path.startsWith(`${d}/`)).length + 1).replace(/\.[a-z]+$/, "");
        out[id] = { fingerprint: digest(value), value };
      }
      continue;
    }
    const value = contract.probes.map(p => probe(p, readFile));
    // A contract whose artifacts do not exist yet has not been introduced.
    if (value.every(v => v?.absent)) continue;
    out[contract.id] = { fingerprint: digest(value), value };
  }
  return out;
}

/** Combined digest of every contract in a checkout rooted at `root`. A missing
 * registered file or directory is a build-context error, never an absent
 * contract, so two build contexts cannot silently disagree. */
export function packContractDigest(root, { read, list } = checkoutSources(root)) {
  for (const path of probePaths()) {
    if (read(path) === null) throw new Error(`Registered contract source is missing: ${path}`);
  }
  for (const dir of expandDirs()) {
    if (list(dir).length === 0) throw new Error(`Registered contract directory is missing: ${dir}`);
  }
  const contracts = fingerprintContracts(read, list);
  return digest(Object.fromEntries(Object.entries(contracts).map(([id, c]) => [id, c.fingerprint])));
}

/** Repository-relative readers over a checkout. */
export function checkoutSources(root) {
  return {
    read: path => {
      const absolute = join(root, path);
      return existsSync(absolute) && statSync(absolute).isFile() ? readFileSync(absolute, "utf8") : null;
    },
    list: dir => existsSync(join(root, dir)) ? readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => relative(root, join(entry.parentPath, entry.name)).split("\\").join("/")) : [],
  };
}

/** Files that expose no contract artifacts produce no contract. */
function isEmpty(value) {
  const empty = v => v == null || (Array.isArray(v) ? v.every(empty) : typeof v === "object" ? Object.values(v).every(empty) : false);
  return empty(value);
}
const probeCache = new Map();
function probe(spec, readFile) {
  const source = readFile(spec.path);
  if (source === null) return { absent: true };
  const key = `${JSON.stringify(spec, (k, v) => v instanceof RegExp ? String(v) : v)}\0${createHash("sha1").update(source).digest("hex")}`;
  if (!probeCache.has(key)) probeCache.set(key, probeUncached(spec, source));
  return probeCache.get(key);
}
function probeUncached(spec, source) {
  switch (spec.kind) {
    case "json": return canonicalJson(JSON.parse(source), spec);
    case "ts-const": return tsConsts(source, spec);
    case "ts-types": return tsTypes(source, spec);
    case "ts-allowlists": return tsAllowlists(source, spec);
    case "schema-ids": return [...new Set(stringLiterals(parseTs(source)).filter(s => SCHEMA_ID.test(s)))].sort();
    case "rust-consts": return rustConsts(source);
    case "rust-serde": return rustSerde(source);
    case "rust-json-keys": return rustJsonKeys(source);
    case "rust-match-literals": return rustMatchLiterals(source);
    case "rust-env-keys": return rustEnvKeys(source);
    default: throw new Error(`unknown probe kind ${spec.kind}`);
  }
}

// ---------- canonical values ----------

export function digest(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
function canonicalJson(value, { stripDocs = false } = {}) {
  if (Array.isArray(value)) return value.map(v => canonicalJson(v, { stripDocs }));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([k]) => !(stripDocs && DOC_KEYS.has(k)))
      .map(([k, v]) => [k, canonicalJson(v, { stripDocs })]));
  }
  return value;
}

// ---------- TypeScript (via @babel/parser, comments are not AST nodes) ----------

function parseTs(source) {
  return babel.parse(source, { sourceType: "module", plugins: ["typescript"], errorRecovery: true });
}
function topLevelDeclarations(ast) {
  const decls = [];
  for (const stmt of ast.program.body) {
    const node = stmt.type === "ExportNamedDeclaration" && stmt.declaration ? stmt.declaration : stmt;
    decls.push({ node, exported: stmt.type === "ExportNamedDeclaration" });
  }
  return decls;
}
function constBindings(ast) {
  const map = new Map();
  for (const { node, exported } of topLevelDeclarations(ast)) {
    if (node.type !== "VariableDeclaration" || node.kind !== "const") continue;
    for (const d of node.declarations) if (d.id.type === "Identifier" && d.init) map.set(d.id.name, { init: d.init, exported });
  }
  return map;
}
function tsConsts(source, spec) {
  const ast = parseTs(source);
  const bindings = constBindings(ast);
  const out = {};
  // Exported values first. Private helpers they inline are fingerprinted
  // through those values, so renaming a helper is not a contract change.
  const inlined = new Set();
  const ordered = [...bindings].sort(([, a], [, b]) => Number(b.exported) - Number(a.exported));
  for (const [name, { init, exported }] of ordered) {
    if (spec.include && !spec.include.test(name)) continue;
    if (spec.exclude && spec.exclude.test(name)) continue;
    if (!exported && (inlined.has(name) || spec.exportedOnly)) continue;
    inlinedNames = exported ? inlined : null;
    const value = astValue(init, source, bindings, new Set([name]));
    inlinedNames = null;
    // Functions and class instances are implementation, not contract data.
    if (value && typeof value === "object" && value.$impl) continue;
    out[name] = canonicalJson(value, spec);
  }
  return out;
}
/** Collects private helpers inlined while evaluating an exported value. */
let inlinedNames = null;
function astValue(node, source, bindings, seen) {
  switch (node.type) {
    case "TSAsExpression": case "TSSatisfiesExpression": case "TSNonNullExpression": case "ParenthesizedExpression":
      return astValue(node.expression, source, bindings, seen);
    case "StringLiteral": case "NumericLiteral": case "BooleanLiteral": return node.value;
    case "NullLiteral": return null;
    case "TemplateLiteral":
      return node.expressions.length === 0 ? node.quasis.map(q => q.value.cooked).join("")
        : { $template: node.quasis.map(q => q.value.cooked), parts: node.expressions.map(e => astValue(e, source, bindings, seen)) };
    case "BinaryExpression":
      if (node.operator === "+") {
        const l = astValue(node.left, source, bindings, seen), r = astValue(node.right, source, bindings, seen);
        if (typeof l === "string" && typeof r === "string") return l + r;
      }
      return { $expr: normalizedSlice(node, source) };
    case "ArrayExpression":
      return node.elements.flatMap(el => {
        if (!el) return [null];
        if (el.type === "SpreadElement") {
          const v = astValue(el.argument, source, bindings, seen);
          return Array.isArray(v) ? v : v?.$set ?? [{ $spread: v }];
        }
        return [astValue(el, source, bindings, seen)];
      });
    case "ObjectExpression": {
      const out = {};
      for (const prop of node.properties) {
        if (prop.type === "SpreadElement") Object.assign(out, objectOrRef(astValue(prop.argument, source, bindings, seen)));
        else if (prop.type === "ObjectProperty" && !prop.computed) out[prop.key.name ?? prop.key.value] = astValue(prop.value, source, bindings, seen);
        else return { $impl: true };
      }
      return out;
    }
    case "NewExpression":
      if (node.callee.type === "Identifier" && node.callee.name === "Set" && node.arguments[0]) {
        const items = astValue(node.arguments[0], source, bindings, seen);
        return { $set: Array.isArray(items) ? [...items].sort((a, b) => String(a).localeCompare(String(b))) : items };
      }
      return { $impl: true };
    case "CallExpression":
      if (node.callee.type === "MemberExpression" && node.callee.object.name === "Object" && node.callee.property.name === "freeze") {
        return astValue(node.arguments[0], source, bindings, seen);
      }
      return { $impl: true };
    case "Identifier":
      if (bindings.has(node.name) && !seen.has(node.name)) {
        inlinedNames?.add(node.name);
        return astValue(bindings.get(node.name).init, source, bindings, new Set([...seen, node.name]));
      }
      return { $ref: node.name };
    case "MemberExpression": {
      // Resolve `helper.properties.kind` through the helper's literal value.
      if (!node.computed) {
        const object = astValue(node.object, source, bindings, seen);
        if (object && typeof object === "object" && !Array.isArray(object) && Object.hasOwn(object, node.property.name)) {
          return object[node.property.name];
        }
      }
      return { $expr: normalizedSlice(node, source) };
    }
    case "ArrowFunctionExpression": case "FunctionExpression": case "ClassExpression": return { $impl: true };
    default: return { $expr: normalizedSlice(node, source) };
  }
}
function objectOrRef(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : { $spread: v }; }

function tsTypes(source, spec) {
  const ast = parseTs(source);
  const out = {};
  for (const { node, exported } of topLevelDeclarations(ast)) {
    if (spec.exported && !exported) continue;
    if (node.type === "TSInterfaceDeclaration") {
      out[node.id.name] = {
        extends: (node.extends ?? []).map(e => normalizedSlice(e, source)),
        members: node.body.body.map(m => typeMember(m, source)).sort((a, b) => a.name.localeCompare(b.name)),
      };
    } else if (node.type === "TSTypeAliasDeclaration") {
      out[node.id.name] = typeShape(node.typeAnnotation, source);
    }
  }
  return out;
}
function typeMember(m, source) {
  if (m.type === "TSPropertySignature") {
    return { name: m.key.name ?? m.key.value ?? normalizedSlice(m.key, source), optional: !!m.optional, readonly: !!m.readonly,
      type: m.typeAnnotation ? typeShape(m.typeAnnotation.typeAnnotation, source) : null };
  }
  return { name: `#${m.type}`, text: normalizedSlice(m, source) };
}
function typeShape(node, source) {
  if (node.type === "TSTypeLiteral") return { members: node.members.map(m => typeMember(m, source)).sort((a, b) => a.name.localeCompare(b.name)) };
  if (node.type === "TSUnionType") return { union: node.types.map(t => stableStringify(typeShape(t, source))).sort() };
  return normalizedSlice(node, source);
}

/** String allowlists a parser enforces: `new Set([...])` and `exact(value, [...])`. */
function tsAllowlists(source, spec) {
  const ast = parseTs(source);
  const out = {};
  for (const { node } of topLevelDeclarations(ast)) {
    if (node.type !== "FunctionDeclaration" || !node.id || !spec.functions.test(node.id.name)) continue;
    const lists = [];
    walk(node.body, n => {
      if (n.type === "NewExpression" && n.callee.name === "Set" && n.arguments[0]?.type === "ArrayExpression") {
        lists.push({ set: stringElements(n.arguments[0]) });
      } else if (n.type === "CallExpression" && n.callee.name === "exact" && n.arguments[1]?.type === "ArrayExpression") {
        lists.push({ exact: stringElements(n.arguments[1]), at: n.arguments[2] ? normalizedSlice(n.arguments[2], source) : null });
      } else if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.property.name === "includes"
        && n.callee.object.type === "ArrayExpression") {
        lists.push({ includes: stringElements(n.callee.object) });
      }
    });
    if (lists.length) out[node.id.name] = lists.map(l => stableStringify(l)).sort();
  }
  return out;
}
function stringElements(arr) {
  return arr.elements.filter(e => e?.type === "StringLiteral").map(e => e.value).sort();
}
function stringLiterals(ast) {
  const out = [];
  walk(ast.program, n => { if (n.type === "StringLiteral") out.push(n.value); });
  return out;
}
function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach(c => walk(c, visit));
    else if (child && typeof child.type === "string") walk(child, visit);
  }
}
/** Source text of a node with comments removed and whitespace collapsed. */
function normalizedSlice(node, source) {
  return stripJsComments(source.slice(node.start, node.end)).replace(/\s+/g, " ").replace(/\s*([{}()[\],;:<>|&=?])\s*/g, "$1").replace(/,([}\])>])/g, "$1").trim();
}
function stripJsComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

// ---------- Rust (lexical, no syn available) ----------

function stripRustComments(source) {
  let out = "", i = 0;
  while (i < source.length) {
    const c = source[i], n = source[i + 1];
    if (c === "/" && n === "/") { while (i < source.length && source[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { let depth = 1; i += 2; while (i < source.length && depth) { if (source.startsWith("/*", i)) { depth++; i += 2; } else if (source.startsWith("*/", i)) { depth--; i += 2; } else i++; } continue; }
    const raw = /^r(#*)"/.exec(source.slice(i, i + 10));
    if (raw && !/[\w]/.test(source[i - 1] ?? "")) {
      const end = source.indexOf(`"${raw[1]}`, i + raw[0].length);
      out += source.slice(i, end + 1 + raw[1].length); i = end + 1 + raw[1].length; continue;
    }
    if (c === '"') { let j = i + 1; while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1; out += source.slice(i, j + 1); i = j + 1; continue; }
    if (c === "'" && /^'(\\.|[^\\'])'/.test(source.slice(i, i + 4))) { const m = /^'(\\.|[^\\'])'/.exec(source.slice(i)); out += m[0]; i += m[0].length; continue; }
    out += c; i++;
  }
  return out;
}
function withoutTestModules(text) {
  let out = text;
  for (let m; (m = /#\[cfg\(test\)\]\s*mod\s+\w+\s*\{/.exec(out));) {
    let depth = 0, j = m.index + m[0].length - 1;
    for (; j < out.length; j++) { if (out[j] === "{") depth++; else if (out[j] === "}" && --depth === 0) break; }
    out = out.slice(0, m.index) + out.slice(j + 1);
  }
  return out;
}
function rustStrings(text) {
  return [...text.matchAll(/"((?:\\.|[^"\\])*)"/g)].map(m => m[1]);
}
function rustConsts(source) {
  const text = stripRustComments(source);
  const out = {};
  for (const m of text.matchAll(/\b(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Z][A-Z0-9_]*)\s*:[^=]+=/g)) {
    const end = text.indexOf(";", m.index + m[0].length);
    out[m[1]] = [...rustStrings(text.slice(m.index + m[0].length, end))].sort();
  }
  return out;
}
/** Serde-visible shapes: derive(Serialize|Deserialize) items with their serde attributes and bodies. */
function rustSerde(source) {
  const text = withoutTestModules(stripRustComments(source));
  const out = {};
  const item = /((?:#\[[^\]]*\]\s*)+)(?:pub(?:\([^)]*\))?\s+)?(struct|enum)\s+(\w+)(<[^>{]*>)?/g;
  for (const m of text.matchAll(item)) {
    const attrs = m[1];
    if (!/derive\([^)]*\b(Serialize|Deserialize)\b/.test(attrs)) continue;
    let i = m.index + m[0].length;
    while (i < text.length && text[i] !== "{" && text[i] !== ";" && text[i] !== "(") i++;
    let body = "";
    if (text[i] === "{" || text[i] === "(") {
      const open = text[i], close = open === "{" ? "}" : ")";
      let depth = 0, j = i;
      for (; j < text.length; j++) { if (text[j] === open) depth++; else if (text[j] === close && --depth === 0) break; }
      body = text.slice(i, j + 1);
    }
    out[`${m[2]} ${m[3]}`] = {
      serde: (attrs.match(/#\[serde\([^\]]*\)\]/g) ?? []).map(a => a.replace(/\s+/g, "")).sort(),
      // `#[serde(skip)]` fields never reach the wire or the persisted file.
      body: body.replace(/#\[serde\(skip\)\]\s*(?:pub(?:\([^)]*\))?\s+)?\w+\s*:[^,{}]*(?:<[^>]*>)?[^,{}]*,?/g, "")
        .replace(/\bpub(\([^)]*\))?\s+/g, "").replace(/\s+/g, " ").replace(/\s*([{}(),:<>;\[\]=])\s*/g, "$1").replace(/,([})\]])/g, "$1"),
    };
  }
  return out;
}

/** Payload keys built or read in code: `json!({"key": ...})`, `["key"]`, `.get("key")`. */
function rustJsonKeys(source) {
  const text = withoutTestModules(stripRustComments(source));
  const writes = new Set(), reads = new Set();
  for (const m of text.matchAll(/json!\s*\(/g)) {
    const body = balanced(text, m.index + m[0].length - 1, "(", ")");
    for (const k of body.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)) writes.add(k[1]);
  }
  for (const m of text.matchAll(/\[\s*"((?:\\.|[^"\\])*)"\s*\]|\.get\(\s*"((?:\\.|[^"\\])*)"\s*\)/g)) reads.add(m[1] ?? m[2]);
  return { writes: [...writes].sort(), reads: [...reads].sort() };
}
/** Inline accept-sets: string literals in `matches!(...)` and in match-arm patterns. */
function rustMatchLiterals(source) {
  const text = withoutTestModules(stripRustComments(source));
  const out = new Set();
  for (const m of text.matchAll(/matches!\s*\(/g)) {
    for (const s of rustStrings(balanced(text, m.index + m[0].length - 1, "(", ")"))) out.add(s);
  }
  const lit = String.raw`"(?:\\.|[^"\\])*"`;
  for (const m of text.matchAll(new RegExp(`(${lit}(?:\\s*\\|\\s*${lit})*)\\s*(?:if\\b[^=]*)?=>`, "g"))) {
    for (const s of rustStrings(m[1])) out.add(s);
  }
  return [...out].sort();
}
function balanced(text, start, open, close) {
  let depth = 0, j = start;
  for (; j < text.length; j++) { if (text[j] === open) depth++; else if (text[j] === close && --depth === 0) break; }
  return text.slice(start, j + 1);
}
/** Environment keys passed or read in code: `keys.push("K")`, `.env("K", ..)`,
 * `.env_remove("K")` and `env::var("K")` / `env::var_os("K")`. */
function rustEnvKeys(source) {
  const text = withoutTestModules(stripRustComments(source));
  const keys = new Set();
  const pattern = /(?:keys\.push|\.env|\.env_remove|env::var|env::var_os)\(\s*"([A-Z][A-Z0-9_]*)"/g;
  for (const m of text.matchAll(pattern)) keys.add(m[1]);
  return [...keys].sort();
}
