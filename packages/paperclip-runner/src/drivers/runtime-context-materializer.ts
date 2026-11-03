import { isOpenRouterUrl, OPENROUTER_ATTRIBUTION_HEADERS } from "./openrouter-attribution.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { codexObservabilityToml } from "./agent-observability.js";

import type { NativeRuntimeContextSnapshot } from "../contracts/runtime-context.js";
import type { NativeMcpLaunchBinding } from "./native-mcp.js";

async function assertSafeTree(root: string, child = ""): Promise<void> {
  const directory = child ? join(root, child) : root;
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink()) {
    throw new Error(
      `runtime context asset contains a symlink: ${child || "."}`,
    );
  }
  if (!directoryStat.isDirectory()) {
    throw new Error("runtime context asset root must be a directory");
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = child ? `${child}/${entry.name}` : entry.name;
    const stat = await lstat(join(root, childRelative));
    if (stat.isSymbolicLink()) {
      throw new Error(
        `runtime context asset contains a symlink: ${childRelative}`,
      );
    }
    if (stat.isDirectory()) await assertSafeTree(root, childRelative);
    else if (!stat.isFile()) {
      throw new Error(
        `runtime context asset contains an unsupported file: ${childRelative}`,
      );
    }
  }
}

function safeMaterializationTarget(root: string, runtimeName: string): string {
  const segments = runtimeName.split("/");
  if (
    runtimeName.startsWith("/")
    || runtimeName.includes("\\")
    || runtimeName.includes("\0")
    || segments.some((segment) => /[<>:"|?*\u0000-\u001f\u007f]/u.test(segment))
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || segments.some((segment) => !segment.replace(/[ .]+$/u, ""))
    || segments.some(isWin32ReservedPathSegment)
  ) {
    throw new Error("runtime context skill name must be a safe relative path");
  }
  const target = resolve(root, runtimeName);
  const relation = relative(resolve(root), target);
  if (
    relation === ""
    || relation === ".."
    || relation.startsWith(`..${sep}`)
    || isAbsolute(relation)
  ) {
    throw new Error("runtime context skill name must stay inside the skills home");
  }
  return target;
}

function isWin32ReservedPathSegment(segment: string): boolean {
  const basename = segment
    .normalize("NFC")
    .split(".", 1)[0]!
    .replace(/[ .]+$/u, "")
    .toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(
    basename,
  );
}

function portableRuntimeNameKey(runtimeName: string): string {
  // Skill assignments must remain unambiguous when the same context is moved
  // between the case-sensitive Linux runner and the case-insensitive default
  // filesystems on macOS or Windows. NFC also catches composed/decomposed
  // aliases, while per-segment trimming matches Win32's treatment of trailing
  // dots and spaces before either spelling reaches the staging tree.
  return runtimeName
    .normalize("NFC")
    .split("/")
    .map((segment) => segment.replace(/[ .]+$/u, ""))
    .join("/")
    .toLowerCase();
}

async function protectStagedTree(root: string): Promise<void> {
  const rootHandle = await open(
    root,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_DIRECTORY ?? 0),
  );
  try {
    const opened = await rootHandle.stat();
    if (!opened.isDirectory()) {
      throw new Error("staged runtime context root must be a directory");
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const child = join(root, entry.name);
      if (entry.isDirectory()) {
        await protectStagedTree(child);
        continue;
      }
      const childHandle = await open(
        child,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const openedChild = await childHandle.stat();
        if (!openedChild.isFile()) {
          throw new Error("staged runtime context asset must be a regular file");
        }
        await childHandle.chmod(openedChild.mode & 0o555);
      } finally {
        await childHandle.close();
      }
    }
    // Seal directories only after their descendants. Traversal needs execute
    // permission, but provider processes must not be able to rewrite assigned
    // skills after the immutable snapshot has been published.
    await rootHandle.chmod(0o555);
  } finally {
    await rootHandle.close();
  }
}

async function unprotectMaterializedTree(root: string): Promise<void> {
  const rootHandle = await open(
    root,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_DIRECTORY ?? 0),
  );
  try {
    const opened = await rootHandle.stat();
    if (!opened.isDirectory()) {
      throw new Error("materialized runtime context root must be a directory");
    }
    // Restore directory mutation before descending so every child can be
    // unlinked. Handles plus O_NOFOLLOW keep cleanup inside the sealed tree.
    await rootHandle.chmod(0o700);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const child = join(root, entry.name);
      if (entry.isDirectory()) {
        await unprotectMaterializedTree(child);
        continue;
      }
      const childHandle = await open(
        child,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const openedChild = await childHandle.stat();
        if (!openedChild.isFile()) {
          throw new Error("materialized runtime context asset must be a regular file");
        }
        await childHandle.chmod(0o600);
      } finally {
        await childHandle.close();
      }
    }
  } finally {
    await rootHandle.close();
  }
}

async function removeMaterializedTree(
  skillsHome: string,
  removeTree: (path: string) => Promise<void>,
): Promise<void> {
  const exists = await lstat(skillsHome).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (!exists) return;
  await unprotectMaterializedTree(skillsHome);
  await removeTree(skillsHome);
}

/** Removes a previously sealed skills snapshot at an explicit lifecycle boundary. */
export async function releaseMaterializedNativeRuntimeSkills(
  skillsHome: string,
): Promise<void> {
  await removeMaterializedTree(
    skillsHome,
    (path) => rm(path, { recursive: true, force: true }),
  );
}

export async function materializeNativeRuntimeSkills(
  context: NativeRuntimeContextSnapshot | null,
  skillsHome: string,
  dependencies: {
    /** Internal test seam for failed staging cleanup coverage. */
    removeTree?: (path: string) => Promise<void>;
    /** Internal test seam for publication failure coverage. */
    renameTree?: (source: string, destination: string) => Promise<void>;
  } = {},
): Promise<void> {
  const removeTree =
    dependencies.removeTree ??
    ((path: string) => rm(path, { recursive: true, force: true }));
  const renameTree = dependencies.renameTree ?? rename;
  if (context) {
    const runtimeNames = new Set<string>();
    for (const skill of context.skills) {
      safeMaterializationTarget(skillsHome, skill.runtimeName);
      const runtimeName = portableRuntimeNameKey(skill.runtimeName);
      if (runtimeNames.has(runtimeName)) {
        throw new Error("runtime context skill names must not overlap");
      }
      runtimeNames.add(runtimeName);
    }
    for (const runtimeName of runtimeNames) {
      const segments = runtimeName.split("/");
      for (let length = 1; length < segments.length; length += 1) {
        if (runtimeNames.has(segments.slice(0, length).join("/"))) {
          throw new Error("runtime context skill names must not overlap");
        }
      }
    }
    for (const skill of context.skills) {
      await assertSafeTree(skill.bundle.rootPath);
    }
  }

  const skillsHomeExists = await lstat(skillsHome).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (skillsHomeExists) {
    throw new Error(
      "runtime context skills home must be a fresh destination",
    );
  }

  const parent = dirname(skillsHome);
  const nonce = randomUUID();
  const stagingHome = join(parent, `.paperclip-skills-staging-${nonce}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  await mkdir(stagingHome, { mode: 0o700 });
  try {
    for (const skill of context?.skills ?? []) {
      const target = safeMaterializationTarget(stagingHome, skill.runtimeName);
      await cp(skill.bundle.rootPath, target, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      await assertSafeTree(target);
      await protectStagedTree(target);
    }

    // The caller supplies a new isolated home for each provider launch. Never
    // move an existing assignment out of its canonical path: a failed bounded
    // rollback cannot portably guarantee that name is restored on every
    // filesystem. Publication therefore targets only a fresh destination.
    await renameTree(stagingHome, skillsHome);
  } catch (error) {
    // Cleanup is best effort and must not replace the publication failure that
    // explains why no runtime snapshot was installed.
    await removeMaterializedTree(stagingHome, removeTree).catch(() => undefined);
    throw error;
  }
}

async function readSourceCodexAuth(sourceAuth: string): Promise<Buffer | null> {
  const handle = await open(
    sourceAuth,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ELOOP") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    if (stat.size > 1024 * 1024) {
      throw new Error("source Codex auth file exceeds the 1 MiB limit");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Copy only Paperclip's value-free provider projection, never host tools or hooks. */
async function managedCodexProviders(sourceHome?: string | null): Promise<{
  providers: Record<string, unknown>;
  modelProvider: string;
} | null> {
  if (!sourceHome?.trim()) return null;
  const source = await readSourceCodexAuth(join(sourceHome, "config.toml"));
  if (!source) return null;
  let parsed;
  try { parsed = parseToml(source.toString("utf8")); } catch { return null; }
  if (parsed.model_provider !== "paperclip") return null;
  const providers = parsed.model_providers as Record<string, unknown> | undefined;
  const provider = providers?.paperclip as Record<string, unknown> | undefined;
  if (!provider || typeof provider.base_url !== "string" || provider.wire_api !== "responses"
    || provider.requires_openai_auth !== false
    || (provider.env_key !== undefined && provider.env_key !== "PAPERCLIP_AI_PROVIDER_KEY")) {
    throw new Error("Invalid managed Codex provider configuration");
  }
  const url = new URL(provider.base_url);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Invalid managed Codex provider URL");
  }
  const block: Record<string, unknown> = {
    name: "Paperclip connection",
    base_url: provider.base_url,
    wire_api: "responses",
    requires_openai_auth: false,
  };
  if (provider.env_key) block.env_key = CODEX_PROVIDER_KEY_ENV;
  if (isOpenRouterUrl(provider.base_url)) block.http_headers = { ...OPENROUTER_ATTRIBUTION_HEADERS };
  return { providers: { paperclip: block }, modelProvider: "paperclip" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CODEX_PROVIDER_KEY_ENV = "PAPERCLIP_AI_PROVIDER_KEY";

/**
 * Read `PAPERCLIP_CODEX_PROVIDERS`, the same contract the Codex harness probe
 * reads, and convert it into `[model_providers.*]` tables.
 *
 * Only providers that declare their own `base_url` are accepted: a provider
 * without an endpoint overrides a built-in one and cannot carry a credential
 * here. Every `{env:...}` reference is resolved before it reaches the file,
 * except in `env_key`, which is a variable name.
 */
export function codexCustomProviders(
  environment: Record<string, string | undefined> | undefined,
): { providers: Record<string, unknown>; modelProvider: string | null; providerKey: string | null } {
  const empty = { providers: {}, modelProvider: null, providerKey: null };
  const raw = environment?.PAPERCLIP_CODEX_PROVIDERS;
  if (typeof raw !== "string" || raw.trim().length === 0) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) return empty;
  const providers: Record<string, unknown> = {};
  const keys = new Map<string, string>();
  for (const [providerId, entry] of Object.entries(parsed.providers)) {
    if (!isRecord(entry) || providerId.trim().length === 0) continue;
    const resolved = resolveProviderFields(entry, environment);
    if (!resolved) continue;
    if (typeof resolved.base_url !== "string" || resolved.base_url.trim().length === 0) continue;
    // Codex has no proxy in this path, so every header value it accepts is
    // written into the agent-readable `config.toml`. `env_http_headers` would
    // name a variable the sanitized child does not keep. Both forms are skipped
    // rather than shipped either broken or in the clear.
    if (isRecord(resolved.http_headers) || isRecord(resolved.env_http_headers)) continue;
    const envKey = typeof entry.env_key === "string" ? entry.env_key.trim() : "";
    const key = envKey ? environment?.[envKey] : undefined;
    if (key) {
      keys.set(providerId, key);
      resolved.env_key = CODEX_PROVIDER_KEY_ENV;
    }
    providers[providerId] = resolved;
  }
  if (Object.keys(providers).length === 0) return empty;
  const selected = typeof parsed.model_provider === "string" ? parsed.model_provider.trim() : "";
  const modelProvider = selected && selected in providers ? selected : null;
  return { providers, modelProvider, providerKey: modelProvider ? keys.get(modelProvider) ?? null : null };
}

/**
 * Resolve `{env:...}` references in provider fields, keeping credentials out of
 * the file. Only `base_url` may carry a reference; every other field that still
 * holds one is dropped, because header names are arbitrary and no name-based
 * rule can tell a routing header from a credential one.
 */
function resolveProviderFields(
  entry: Record<string, unknown>,
  environment: Record<string, string | undefined> | undefined,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value === "string") {
      if (!value.includes("{env:")) {
        out[key] = value;
        continue;
      }
      if (key !== "base_url") continue;
      out[key] = value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) =>
        environment?.[name] ?? match,
      );
      continue;
    }
    if (Array.isArray(value)) {
      if (value.some((item) => typeof item === "string" && item.includes("{env:"))) continue;
      out[key] = value;
      continue;
    }
    if (isRecord(value)) {
      const nested = resolveProviderFields(value, environment);
      if (nested && Object.keys(nested).length > 0) out[key] = nested;
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Merge the managed projection and the custom tables into one TOML document. */
function codexProviderToml(
  custom: { providers: Record<string, unknown>; modelProvider: string | null },
  managed: { providers: Record<string, unknown>; modelProvider: string } | null,
): { toml: string; modelProvider: string | null } {
  const providers: Record<string, unknown> = { ...(managed?.providers ?? {}) };
  for (const [providerId, block] of Object.entries(custom.providers)) {
    const previous = providers[providerId];
    providers[providerId] = isRecord(previous) && isRecord(block)
      ? { ...previous, ...block }
      : block;
  }
  if (Object.keys(providers).length === 0) return { toml: "", modelProvider: null };
  const document: Record<string, unknown> = { model_providers: providers };
  const selected = custom.modelProvider ?? managed?.modelProvider ?? null;
  const modelProvider = selected && selected in providers ? selected : null;
  if (modelProvider) document.model_provider = modelProvider;
  return { toml: `${stringifyToml(document)}\n`, modelProvider };
}

/**
 * Resolve the provider tables this run writes.
 *
 * A selected custom provider owns routing, so the source home is not read: a
 * stale managed entry the run never uses must not stop it.
 */
async function codexProviderConfigFor(input: {
  environment?: Record<string, string | undefined>;
  sourceCodexHome?: string | null;
}): Promise<{ toml: string; modelProvider: string | null; providerKey: string | null }> {
  const custom = codexCustomProviders(input.environment);
  const managed = custom.modelProvider ? null : await managedCodexProviders(input.sourceCodexHome);
  return { ...codexProviderToml(custom, managed), providerKey: custom.providerKey };
}

/**
 * A custom provider credential reaches Codex through the one variable its
 * sanitized child environment keeps.
 */
function applyProviderKey(
  environment: Record<string, string | undefined> | undefined,
  providerKey: string | null,
): void {
  if (!environment || !providerKey) return;
  environment[CODEX_PROVIDER_KEY_ENV] = providerKey;
}

export async function prepareIsolatedCodexHome(input: {
  observability?: import("./agent-observability.js").ProviderObservabilityLaunch;
  context: NativeRuntimeContextSnapshot | null;
  codexHome: string;
  sourceCodexHome?: string | null;
  nativeMcp?: NativeMcpLaunchBinding | null;
  apiKey?: string | null;
  environment?: Record<string, string | undefined>;
}): Promise<void> {
  await materializeNativeRuntimeSkills(
    input.context,
    join(input.codexHome, "skills"),
  );

  const { toml: providerConfig, modelProvider: selectedProvider, providerKey } =
    await codexProviderConfigFor(input);
  applyProviderKey(input.environment, providerKey);
  await writeIsolatedCodexConfig(input, providerConfig);
  await writeIsolatedCodexAuth(input, selectedProvider);
}

async function writeIsolatedCodexConfig(input: CodexAuthInput & { nativeMcp?: NativeMcpLaunchBinding | null }, providerConfig: string): Promise<void> {
  const configPath = join(input.codexHome, "config.toml");
  await mkdir(input.codexHome, { recursive: true, mode: 0o700 });
  await chmod(input.codexHome, 0o700);
  const temporaryConfig = join(input.codexHome, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryConfig, [
      'cli_auth_credentials_store = "file"',
      providerConfig,
      codexObservabilityToml(input.observability?.otelConfig),
      // Codex shell snapshots serialize the provider process environment. The
      // native runner injects short-lived provider and MCP bindings, so a
      // snapshot would turn ephemeral credentials into durable session state.
      "[features]",
      "shell_snapshot = false",
      "",
      ...(input.nativeMcp
        ? [
            `[mcp_servers.${JSON.stringify(input.nativeMcp.name)}]`,
            `url = ${JSON.stringify(input.nativeMcp.url)}`,
            // This endpoint is Paperclip's authenticated policy gateway, not an
            // upstream server. It enforces connection grants and human approvals
            // for every operation; the provider must deliver calls to that gate.
            'default_tools_approval_mode = "approve"',
            `http_headers = { Authorization = ${JSON.stringify(`Bearer ${input.nativeMcp.token}`)} }`,
            "",
          ]
        : []),
    ].join("\n"), { mode: 0o600, flag: "wx" });
    await rename(temporaryConfig, configPath);
    await chmod(configPath, 0o600);
  } finally { await rm(temporaryConfig, { force: true }); }
}

type CodexAuthInput = {
  codexHome: string;
  sourceCodexHome?: string | null;
  apiKey?: string | null;
  environment?: Record<string, string | undefined>;
  observability?: import("./agent-observability.js").ProviderObservabilityLaunch;
};

export async function prepareIsolatedCodexRecoveryHome(input: CodexAuthInput & { nativeMcp?: NativeMcpLaunchBinding | null }): Promise<void> {
  const { toml: providerConfig, modelProvider: selectedProvider, providerKey } =
    await codexProviderConfigFor(input);
  applyProviderKey(input.environment, providerKey);
  await writeIsolatedCodexConfig(input, providerConfig);
  await writeIsolatedCodexAuth(input, selectedProvider);
}

async function writeIsolatedCodexAuth(input: CodexAuthInput, selectedProvider: string | null): Promise<void> {
  await mkdir(input.codexHome, { recursive: true, mode: 0o700 });
  const targetAuth = join(input.codexHome, "auth.json");
  await rm(targetAuth, { force: true });
  // Only a selected provider replaces the auth fallback; an unselected table
  // leaves Codex on its default provider, which still needs the key or auth file.
  if (selectedProvider) return;
  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    // The pinned Codex app-server authenticates API-key automation through its
    // login cache rather than the CLI-only CODEX_API_KEY path. Keep this file
    // owner-only in the disposable session home.
    await writeFile(
      targetAuth,
      JSON.stringify({ OPENAI_API_KEY: apiKey }),
      { mode: 0o600 },
    );
    await chmod(targetAuth, 0o600);
    return;
  }

  const sourceHome = input.sourceCodexHome?.trim();
  if (!sourceHome) return;
  const sourceAuth = await readSourceCodexAuth(join(sourceHome, "auth.json"));
  if (!sourceAuth) return;
  await writeFile(targetAuth, sourceAuth, { mode: 0o600 });
  await chmod(targetAuth, 0o600);
}
