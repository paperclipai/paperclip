// Fingerprints the contracts that cross the Runner/provider-pack boundary.
// Contracts are declared as JSON (PRP and sidecar schemas, generated catalogs)
// and read structurally, with description text stripped; Rust shapes are read
// lexically (serde structs, payload keys, match literals, env keys). Comments,
// formatting and refactors do not change a fingerprint; a new field, accepted
// value or env key does. build-provider-pack.mjs records the combined digest so
// an image pack is reused only by a controller built from the same contracts.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const R = "packages/paperclip-runner";
const RUST = `${R}/runner/crates/runner-core/src`;
const DOC_KEYS = new Set(["description", "title", "$comment", "examples", "markdownDescription"]);

/** Contract registry. Each contract binds probes; a probe reads one artifact.
 * Only trees present in every pack build context are read (Docker contexts
 * exclude tests, fixtures and docs), so the digest is the same wherever a pack
 * is built. A TypeScript contract joins the digest by moving its definition
 * into a schema under protocol/ and generating the TypeScript from it. */
export const CONTRACTS = [
  { id: "prp.schemas", expand: { kind: "json-dir", dirs: [`${R}/protocol/schemas`, `${R}/protocol/provider-schemas`] } },
  { id: "generated", expand: { dirs: [`${R}/generated`], suffix: ".json", idPrefix: "generated.", probes: [{ kind: "json", stripDocs: true }] } },
  { id: "rust", expand: { dirs: [RUST], suffix: ".rs", idPrefix: "rust.", probes: [
    { kind: "rust-serde" }, { kind: "rust-json-keys" }, { kind: "rust-match-literals" }, { kind: "rust-env-keys" },
  ] } },
  // Reserved and forwarded runtime env keys are const lists in Rust.
  { id: "configured-environment", probes: [{ kind: "rust-consts", path: `${RUST}/configured_environment.rs` }] },
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
      const candidates = dirs.flatMap(listDir).filter(p => p.endsWith(suffix) && !exclude?.test(p));
      const testOnly = suffix === ".rs" ? rustTestOnlyFiles(candidates, readFile) : new Set();
      for (const path of candidates.filter(p => !testOnly.has(p)).sort()) {
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
/** With `stripDocs`, drops schema annotations (description, title, $comment,
 * examples) by their value shape: annotations are text or example lists, while
 * a property declared as `properties.description` holds a schema object and is
 * kept with its constraints. */
function canonicalJson(value, { stripDocs = false } = {}) {
  if (Array.isArray(value)) return value.map(v => canonicalJson(v, { stripDocs }));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([k, v]) => !(stripDocs && isAnnotation(k, v)))
      .map(([k, v]) => [k, canonicalJson(v, { stripDocs })]));
  }
  return value;
}
function isAnnotation(key, value) {
  return DOC_KEYS.has(key) && (typeof value === "string" || (key === "examples" && Array.isArray(value)));
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
/** Files compiled only under `#[cfg(test)]`: modules declared as
 * `#[cfg(test)] [#[path = "..."]] mod name;`, their submodules, and files under
 * a test module's directory. Inline `#[cfg(test)] mod name { .. }` blocks are
 * removed separately by withoutTestModules. */
function rustTestOnlyFiles(paths, readFile) {
  const known = new Set(paths);
  const testOnly = new Set();
  const pending = [...paths];
  const declaration = /#\[cfg\(test\)\]\s*((?:#\[[^\]]*\]\s*)*)(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/g;
  const visit = (path) => {
    const source = readFile(path);
    if (source === null) return [];
    const directory = path.slice(0, path.lastIndexOf("/"));
    const file = path.slice(path.lastIndexOf("/") + 1);
    const ownDirectory = /^(lib|main|mod)\.rs$/.test(file) ? directory : `${directory}/${file.replace(/\.rs$/, "")}`;
    const found = [];
    for (const m of stripRustComments(source).matchAll(declaration)) {
      const explicit = /#\[path\s*=\s*"([^"]+)"\s*\]/.exec(m[1])?.[1];
      // A #[path] on a module declared in a non-mod.rs file resolves from the file's directory.
      const targets = explicit ? [normalizePath(`${directory}/${explicit}`)]
        : [`${ownDirectory}/${m[2]}.rs`, `${ownDirectory}/${m[2]}/mod.rs`];
      for (const target of targets) {
        found.push(target);
        const moduleDirectory = target.endsWith("/mod.rs") ? target.slice(0, -"/mod.rs".length) : target.replace(/\.rs$/, "");
        for (const other of known) if (other.startsWith(`${moduleDirectory}/`)) found.push(other);
      }
    }
    return found.filter(target => known.has(target));
  };
  while (pending.length) {
    for (const target of visit(pending.pop())) {
      if (testOnly.has(target)) continue;
      testOnly.add(target);
      pending.push(target);
    }
  }
  return testOnly;
}
function normalizePath(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
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
