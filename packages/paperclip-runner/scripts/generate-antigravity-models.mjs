#!/usr/bin/env node
/**
 * Derives the Google Antigravity model catalog from the pinned 1.5.2 runtime.
 *
 * Generation (on a host with the pinned closure installed) does two reads and
 * requires them to agree:
 * - live: the real patched runtime is started without a credential or prompt,
 *   authenticated with `gemini-api-key` (the server does not validate the key
 *   and builds that catalog locally), and one session lists its models;
 * - static: the server's built-in catalog table, read from the verified
 *   vendor archive, supplies every family's levels, including the Gemini 4
 *   families the server lists only for Agent Platform.
 * The output is bound to the runtime version and the vendor archive identity.
 * `--check` needs no runtime: it rejects a hand-edited file and a file whose
 * binding no longer matches the checked-in distribution declaration.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DISTRIBUTIONS_PATH = join(PACKAGE_ROOT, "antigravity-distributions.json");
export const ANTIGRAVITY_MODELS_OUTPUT = resolve(PACKAGE_ROOT, "../shared/src/antigravity-models.generated.ts");
const SOURCE_PLATFORM = "darwin-arm64";
const SCHEMA = "paperclip.antigravity.model_catalog.v1";
const MODEL_SELECTION_SOURCE = "google3/cloud/developer_experience/antigravity_extensions/acp_server/model_selection.py";
const LEVELS = { MINIMAL: "minimal", LOW: "low", MEDIUM: "medium", HIGH: "high", EXTRA_HIGH: "extra_high" };
/** Not a credential: the server stores it without a network call, and no prompt is sent. */
const PLACEHOLDER_API_KEY = "paperclip-catalog-probe-sends-no-prompt";
const BEGIN = "/* BEGIN GENERATED CATALOG */";
const END = "/* END GENERATED CATALOG */";
const fail = message => { throw new Error(`Antigravity model catalog: ${message}`); };

/** Reads the families from `DEFAULT_MODEL_METADATA_MAP` in the server's own source.
 * Every entry must be a `_thinking_family(...)` call this parser fully understands. */
export function parseAntigravityCatalogSource(source) {
  const tuples = new Map();
  for (const match of source.matchAll(/^(_[A-Z_]+) = \(\s*([^)]*?)\s*\)$/gm)) {
    tuples.set(match[1], parseLevels(match[2]));
  }
  const start = source.indexOf("\nDEFAULT_MODEL_METADATA_MAP = {\n");
  const end = source.indexOf("\n}\n", start);
  if (start < 0 || end < 0) fail("the built-in catalog table was not found");
  const body = source.slice(start + "\nDEFAULT_MODEL_METADATA_MAP = {\n".length, end);
  const code = body.split("\n").filter(line => !line.trim().startsWith("#")).join("\n").trim();
  const calls = code.split(/\*\*_thinking_family\(/).map(part => part.trim()).filter(Boolean);
  if (!code.startsWith("**_thinking_family(")) fail("the built-in catalog has an entry this generator does not understand");
  const families = calls.map(call => {
    const strings = [...call.matchAll(/^\s*"([^"]+)",\s*$/gm)].map(match => match[1]);
    if (strings.length !== 2) fail("a catalog family has an unexpected shape");
    const [id, label] = strings;
    let levels;
    const named = call.match(/^\s*(_[A-Z_]+),\s*$/m);
    const inline = call.match(/^\s*\(\s*([\s\S]*?)\s*\),\s*$/m);
    if (named) levels = tuples.get(named[1]);
    else if (inline) levels = parseLevels(inline[1]);
    if (!levels?.length) fail(`levels for ${id} were not found`);
    const base = call.match(/base_model_id="([^"]+)"/);
    const agentPlatformOnly = /agent_platform_only=True/.test(call);
    const known = call.replace(/^\s*"[^"]+",\s*$/gm, "").replace(/^\s*_[A-Z_]+,\s*$/m, "").replace(/^\s*\(\s*[\s\S]*?\s*\),\s*$/m, "")
      .replace(/max_tokens=[\d_]+,?/, "").replace(/base_model_id="[^"]+",?/, "").replace(/agent_platform_only=True,?/, "").replace(/\),?$/, "");
    if (known.trim()) fail(`${id} has a catalog field this generator does not understand`);
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(id) || !label.trim()) fail("invalid family identity");
    return { id, label, baseModelId: base ? base[1] : id, levels, agentPlatformOnly };
  });
  if (new Set(families.map(family => family.id)).size !== families.length) fail("duplicate family");
  return families;
}

function parseLevels(text) {
  const names = text.split(",").map(part => part.trim()).filter(Boolean);
  return names.map(name => {
    const match = name.match(/^sdk_types_module\.ThinkingLevel\.([A-Z_]+)$/);
    if (!match || !Object.hasOwn(LEVELS, match[1])) fail(`unknown thinking level ${name}`);
    return LEVELS[match[1]];
  });
}

/** Reads one stored or deflated member of the verified ZIP embedded in the server. */
export function readZipMember(zip, name) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) fail("embedded archive has no directory");
  let cursor = zip.readUInt32LE(end + 16);
  const count = zip.readUInt16LE(end + 10);
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) fail("embedded archive directory is invalid");
    const method = zip.readUInt16LE(cursor + 10), compressed = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28), extra = zip.readUInt16LE(cursor + 30), comment = zip.readUInt16LE(cursor + 32);
    const local = zip.readUInt32LE(cursor + 42);
    if (zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8") === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + compressed);
      return method === 0 ? data : method === 8 ? inflateRawSync(data) : fail("unsupported compression");
    }
    cursor += 46 + nameLength + extra + comment;
  }
  return fail(`${name} is not in the embedded archive`);
}

/** Minimal line-delimited JSON-RPC client. Provider text never enters errors. */
function rpcClient(child) {
  const waiting = new Map();
  let buffer = "", bytes = 0, failure;
  const stop = error => { failure ??= error; for (const { reject } of waiting.values()) reject(failure); waiting.clear(); };
  child.stdout.on("data", chunk => {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) { stop(new Error("antigravity_stdout_limit")); return; }
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const line = buffer.slice(0, buffer.indexOf("\n")); buffer = buffer.slice(buffer.indexOf("\n") + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { stop(new Error("antigravity_malformed_json")); return; }
      if (message.method !== undefined) {
        // Requests from the agent are refused; notifications are ignored.
        if (message.id !== undefined) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } })}\n`);
        continue;
      }
      const entry = waiting.get(message.id);
      if (!entry) continue;
      waiting.delete(message.id);
      if (message.error) entry.reject(Object.assign(new Error(`antigravity_request_rejected:${entry.method}`), { rpcError: { code: message.error.code, message: String(message.error.message ?? "").slice(0, 300) } }));
      else entry.resolve(message.result);
    }
  });
  child.once("error", () => stop(new Error("antigravity_spawn_failure")));
  child.once("close", () => stop(new Error("antigravity_exited")));
  let next = 1;
  return (method, params, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = next++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`antigravity_timeout:${method}`)); }, timeoutMs);
    waiting.set(id, { method, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

/**
 * Starts the pinned patched runtime with only an API-key auth choice, runs
 * `steps(request, workspace)` and always stops the process tree. Never sends a
 * prompt.
 */
export async function withPromptFreeAntigravitySession(steps) {
  const { antigravityDistribution, verifyAntigravityDistribution } = await import("./materialize-antigravity-distribution.mjs");
  const { antigravityRuntimeCachePath } = await import("./antigravity-provisioner-layout.mjs");
  const { antigravityMetadataEnvironment, stopAntigravityMetadataChild } = await import("./probe-antigravity-metadata.mjs");
  const distribution = await antigravityDistribution();
  if (`${distribution.platform}-${distribution.architecture}` !== SOURCE_PLATFORM) fail(`generate on ${SOURCE_PLATFORM}`);
  const runtimeDirectory = antigravityRuntimeCachePath(distribution.closureSha256, distribution.platform, distribution.architecture);
  await verifyAntigravityDistribution(runtimeDirectory, distribution);
  const root = await mkdtemp(join(tmpdir(), "paperclip-antigravity-catalog-"));
  let child;
  try {
    const env = { ...antigravityMetadataEnvironment(root, runtimeDirectory), GEMINI_API_KEY: PLACEHOLDER_API_KEY };
    for (const key of ["HOME", "GEMINI_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR"]) await mkdir(env[key], { mode: 0o700 });
    const workspace = join(root, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    child = spawn(join(runtimeDirectory, distribution.executable), distribution.args, { cwd: root, env, stdio: "pipe", detached: true });
    child.stderr.resume();
    const request = rpcClient(child);
    const initialized = await request("initialize", { protocolVersion: 1, clientInfo: { name: "paperclip-runner", version: "1" }, clientCapabilities: {} });
    if (initialized?.agentInfo?.name !== "antigravity-acp" || initialized.agentInfo.version !== distribution.version) fail("runtime identity differs from the pin");
    await request("authenticate", { methodId: "gemini-api-key" });
    return { distribution, result: await steps(request, workspace) };
  } finally {
    await stopAntigravityMetadataChild(child, { eofTimeoutMs: 1_000, terminateTimeoutMs: 1_000, killTimeoutMs: 1_000 });
    await rm(root, { recursive: true, force: true });
  }
}

/** The API-key catalog exactly as one fresh native session lists it. */
export async function readLiveApiKeyCatalog() {
  return withPromptFreeAntigravitySession(async (request, workspace) => {
    const session = await request("session/new", { cwd: workspace, mcpServers: [] });
    const models = session?.models;
    if (!Array.isArray(models?.availableModels) || typeof models.currentModelId !== "string") fail("session did not list models");
    await request("session/close", { sessionId: session.sessionId }).catch(() => undefined);
    return {
      defaultModelId: models.currentModelId,
      models: models.availableModels.map(model => ({ id: model.modelId, label: model.name })),
    };
  });
}

async function staticCatalog(distribution) {
  const { antigravityRuntimeCachePath } = await import("./antigravity-provisioner-layout.mjs");
  const { antigravityEmbeddedArchive, ANTIGRAVITY_PATCH_TARGETS } = await import("./patch-antigravity-runtime.mjs");
  const directory = antigravityRuntimeCachePath(distribution.closureSha256, distribution.platform, distribution.architecture);
  // The patch replaces server.py and SDK files only; the catalog table is vendor source.
  const server = await readFile(join(directory, distribution.executable));
  const { start, length } = antigravityEmbeddedArchive(server, ANTIGRAVITY_PATCH_TARGETS[SOURCE_PLATFORM]);
  return parseAntigravityCatalogSource(readZipMember(server.subarray(start, start + length), MODEL_SELECTION_SOURCE).toString("utf8"));
}

/** Joins the two reads; any disagreement stops generation. */
export function buildAntigravityModelCatalog({ families, live, binding }) {
  const expanded = families.filter(family => !family.agentPlatformOnly).flatMap(family => family.levels.map(level => `${family.id}-${level}`));
  const liveIds = live.models.map(model => model.id);
  if (JSON.stringify(expanded) !== JSON.stringify(liveIds)) fail("the live API-key catalog differs from the built-in table");
  if (!liveIds.includes(live.defaultModelId)) fail("the live default model is not listed");
  const labels = new Map(live.models.map(model => [model.id, model.label]));
  for (const family of families) {
    for (const level of family.levels) {
      const id = `${family.id}-${level}`;
      if (labels.has(id) && !labels.get(id).startsWith(`${family.label} (`)) fail(`label for ${id} differs from its family`);
    }
  }
  return { schema: SCHEMA, source: binding, apiKey: { defaultModelId: live.defaultModelId, models: live.models }, families };
}

export function bindingFromDeclaration(declaration) {
  const item = declaration.platforms?.[SOURCE_PLATFORM];
  if (!item) fail(`${SOURCE_PLATFORM} is not declared`);
  return { runtimeVersion: declaration.version, platform: SOURCE_PLATFORM, archiveSha256: item.archiveSha256, vendorClosureSha256: item.vendorClosureSha256 };
}

export function renderAntigravityModelCatalog(catalog) {
  return `// Generated by packages/paperclip-runner/scripts/generate-antigravity-models.mjs from the
// pinned Google Antigravity runtime. Do not edit; regenerate with
// \`node packages/paperclip-runner/scripts/generate-antigravity-models.mjs\` on darwin-arm64.
${BEGIN}
export const ANTIGRAVITY_GENERATED_MODEL_CATALOG = ${JSON.stringify(catalog, null, 2)} as const;
${END}
`;
}

export function parseRenderedCatalog(text) {
  const start = text.indexOf(BEGIN), end = text.indexOf(END);
  if (start < 0 || end < 0) fail("generated markers are missing");
  const body = text.slice(start + BEGIN.length, end).trim();
  const match = body.match(/^export const ANTIGRAVITY_GENERATED_MODEL_CATALOG = ([\s\S]*) as const;$/);
  if (!match) fail("generated body has an unexpected shape");
  return JSON.parse(match[1]);
}

/** Static staleness check used by the package build. */
export async function checkAntigravityModelCatalog({ output = ANTIGRAVITY_MODELS_OUTPUT, declarationPath = DISTRIBUTIONS_PATH } = {}) {
  const text = await readFile(output, "utf8");
  const catalog = parseRenderedCatalog(text);
  if (renderAntigravityModelCatalog(catalog) !== text) fail("generated file was edited by hand; regenerate it");
  if (catalog.schema !== SCHEMA) fail("unexpected schema");
  const expected = bindingFromDeclaration(JSON.parse(await readFile(declarationPath, "utf8")));
  if (JSON.stringify(catalog.source) !== JSON.stringify(expected)) fail("catalog is stale: the pinned Antigravity runtime changed; regenerate it on darwin-arm64");
  buildAntigravityModelCatalog({ families: catalog.families, live: catalog.apiKey, binding: catalog.source });
  return catalog;
}

async function main() {
  if (process.argv.includes("--check")) {
    await checkAntigravityModelCatalog();
    process.stdout.write("Antigravity model catalog is current.\n");
    return;
  }
  const { distribution, result: live } = await readLiveApiKeyCatalog();
  const binding = bindingFromDeclaration(JSON.parse(await readFile(DISTRIBUTIONS_PATH, "utf8")));
  if (binding.runtimeVersion !== distribution.version) fail("runtime version differs from the declaration");
  const catalog = buildAntigravityModelCatalog({ families: await staticCatalog(distribution), live, binding });
  await writeFile(ANTIGRAVITY_MODELS_OUTPUT, renderAntigravityModelCatalog(catalog));
  process.stdout.write(`Wrote ${catalog.apiKey.models.length} API-key models and ${catalog.families.length} families.\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
