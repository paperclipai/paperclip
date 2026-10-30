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
      const sources = candidates.filter(p => !testOnly.has(p)).sort();
      // Env keys are often passed through `const NAME: &str = "KEY"` defined in
      // another file, so resolve constant arguments crate-wide.
      const constants = suffix === ".rs" ? rustStringConstants(sources, readFile) : {};
      // Serde type names never reach JSON; a reference to one is replaced by the
      // referenced type's shape, which may be defined in another file.
      const typeShapes = suffix === ".rs" ? rustSerdeTypeShapes(sources, readFile) : {};
      const crateWide = { "rust-env-keys": { constants }, "rust-serde": { typeShapes } };
      for (const path of sources) {
        const value = probes.map(p => probe({ ...p, path, ...crateWide[p.kind] }, readFile));
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
    case "rust-serde": return rustSerde(source, spec.typeShapes ?? {});
    case "rust-json-keys": return rustJsonKeys(source);
    case "rust-match-literals": return rustMatchLiterals(source);
    case "rust-env-keys": return rustEnvKeys(source, spec.constants ?? {});
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
const SERDE_ITEM = /((?:#\[[^\]]*\]\s*)+)(?:pub(?:\([^)]*\))?\s+)?(struct|enum)\s+(\w+)(<[^>{]*>)?/g;
const isSerdeItem = attrs => /derive\([^)]*\b(Serialize|Deserialize)\b/.test(attrs);

/** Serialized shapes of a file's derive(Serialize|Deserialize) items: serde
 * attributes and field/variant bodies. Rust type names never reach JSON, so
 * item names are dropped and a reference to a crate serde type is replaced by
 * that type's shape digest; renaming a type is not a contract change, while
 * field and variant names, field types (including which shape a reference
 * names) and serde attributes are. */
function rustSerde(source, typeShapes) {
  return rustSerdeItems(source)
    .map(item => serdeShape(item, name => Object.hasOwn(typeShapes, name) ? typeShapes[name] : null))
    .sort();
}
function serdeShape({ kind, serde, body }, shapeOf) {
  return stableStringify({ kind, serde, body: withNormalizedTypeReferences(body, shapeOf) });
}
/** derive(Serialize|Deserialize) items with whitespace-normalized bodies. */
function rustSerdeItems(source) {
  const text = withoutTestModules(stripRustComments(source));
  const items = [];
  for (const m of text.matchAll(SERDE_ITEM)) {
    const attrs = m[1];
    if (!isSerdeItem(attrs)) continue;
    let i = m.index + m[0].length;
    while (i < text.length && text[i] !== "{" && text[i] !== ";" && text[i] !== "(") i++;
    let body = "";
    if (text[i] === "{" || text[i] === "(") {
      const open = text[i], close = open === "{" ? "}" : ")";
      let depth = 0, j = i;
      for (; j < text.length; j++) { if (text[j] === open) depth++; else if (text[j] === close && --depth === 0) break; }
      body = text.slice(i, j + 1);
    }
    // `#[serde(skip)]` fields never reach the wire or the persisted file.
    const normalized = body.replace(/#\[serde\(skip\)\]\s*(?:pub(?:\([^)]*\))?\s+)?\w+\s*:[^,{}]*(?:<[^>]*>)?[^,{}]*,?/g, "")
      .replace(/\bpub(\([^)]*\))?\s+/g, "").replace(/\s+/g, " ").replace(/\s*([{}(),:<>;\[\]=])\s*/g, "$1").replace(/,([})\]])/g, "$1");
    items.push({
      name: m[3],
      kind: m[2],
      serde: (attrs.match(/#\[serde\([^\]]*\)\]/g) ?? []).map(a => a.replace(/\s+/g, "")).sort(),
      body: normalized,
    });
  }
  return items;
}
/** Replaces crate serde type names in type positions (after `:`, or inside
 * `(..)` and `<..>`) with `$type:<shape>`. Names directly inside `{..}` after
 * `{`, `,` or an attribute are field or variant names, which serialize, and
 * stay. */
function withNormalizedTypeReferences(body, shapeOf) {
  const stack = [];
  let previous = "";
  // Quoted strings (serde renames) are wire names and pass through unchanged.
  return body.replace(/"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z0-9_]*|[^A-Za-z0-9_]/g, token => {
    if (token.startsWith("\"")) { previous = "string"; return token; }
    if (/^[A-Za-z_]/.test(token)) {
      const namePosition = stack.at(-1) === "{" && ["{", ",", "]"].includes(previous);
      previous = "ident";
      const shape = namePosition ? null : shapeOf(token);
      return shape === null ? token : `$type:${shape}`;
    }
    if ("{(<[".includes(token)) stack.push(token);
    else if ("})>]".includes(token)) stack.pop();
    previous = token;
    return token;
  });
}
/** Shape digest of every derive(Serialize|Deserialize) item across the crate,
 * keyed by its Rust name. A reference inside a shape resolves to the referenced
 * shape, so the digest is independent of every Rust type name. A reference back
 * into the current resolution path is recorded by its depth. Items that share a
 * name in different modules resolve to all of their shapes. */
function rustSerdeTypeShapes(paths, readFile) {
  const byName = new Map();
  for (const path of paths) {
    const source = readFile(path);
    if (source === null) continue;
    for (const item of rustSerdeItems(source)) byName.set(item.name, [...(byName.get(item.name) ?? []), item]);
  }
  const resolved = new Map();
  const resolve = (name, path) => {
    if (resolved.has(name)) return { shape: resolved.get(name), cyclic: false };
    const back = path.indexOf(name);
    if (back >= 0) return { shape: `cycle:${path.length - back}`, cyclic: true };
    let cyclic = false;
    const shapes = byName.get(name).map(item => serdeShape(item, reference => {
      if (!byName.has(reference)) return null;
      const result = resolve(reference, [...path, name]);
      cyclic ||= result.cyclic;
      return result.shape;
    })).sort();
    const shape = digest(shapes).slice("sha256:".length, "sha256:".length + 16);
    // A shape inside a cycle depends on where resolution entered it.
    if (!cyclic) resolved.set(name, shape);
    return { shape, cyclic };
  };
  return Object.fromEntries([...byName.keys()].sort().map(name => [name, resolve(name, []).shape]));
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
/** Environment keys passed or read in code: `keys.push(K)`, `.env(K, ..)`,
 * `.env_remove(K)` and `env::var(K)` / `env::var_os(K)`, where K is a string
 * literal or a string constant. A constant resolves to its value, so renaming
 * the Rust constant is not a contract change; an unresolved constant keeps its
 * name so a rename remains visible. */
function rustEnvKeys(source, constants) {
  const text = withoutTestModules(stripRustComments(source));
  const keys = new Set();
  const pattern = /(?:keys\.push|\.env|\.env_remove|env::var|env::var_os)\(\s*(?:"([A-Z][A-Z0-9_]*)"|(?:[a-z_][a-z0-9_]*::)*([A-Z][A-Z0-9_]*)\b)/g;
  for (const m of text.matchAll(pattern)) keys.add(m[1] ?? constants[m[2]] ?? `const:${m[2]}`);
  return [...keys].sort();
}
/** String constants (`const NAME: &str = "VALUE";`) across the crate's sources.
 * Names defined twice with different values are ambiguous and left unresolved. */
function rustStringConstants(paths, readFile) {
  const found = new Map();
  for (const path of paths) {
    const source = readFile(path);
    if (source === null) continue;
    const text = withoutTestModules(stripRustComments(source));
    for (const m of text.matchAll(/\b(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Z][A-Z0-9_]*)\s*:\s*&(?:'static\s+)?str\s*=\s*"([^"\\]*)"\s*;/g)) {
      const values = found.get(m[1]) ?? new Set();
      values.add(m[2]);
      found.set(m[1], values);
    }
  }
  return Object.fromEntries([...found].filter(([, values]) => values.size === 1).map(([name, values]) => [name, [...values][0]]).sort());
}
