import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeInheritedPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";

type PreparedCodexRuntimeConfig = {
  notes: string[];
  cleanup: () => Promise<void>;
};

type ParsedCodexProvidersConfig = {
  providers: Record<string, Record<string, unknown>>;
  modelProvider: string | null;
};

// Marker comments delimiting the Paperclip-managed regions of config.toml.
// TOML requires root-level keys (model_provider) to appear before the first
// table header, while [model_providers.*] tables must not swallow the user's
// root keys, so the managed content is split into a root block prepended to
// the file and a tables block appended to it.
const MANAGED_ROOT_BEGIN = "# >>> paperclip codex providers (root) -- managed, do not edit >>>";
const MANAGED_ROOT_END = "# <<< paperclip codex providers (root) <<<";
const MANAGED_TABLES_BEGIN = "# >>> paperclip codex providers (tables) -- managed, do not edit >>>";
const MANAGED_TABLES_END = "# <<< paperclip codex providers (tables) <<<";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recursively replace {env:VAR} placeholders with the resolved value. Used to bake
// gateway provider secrets into config.toml SERVER-SIDE, where the value is
// reliably present. Prefer codex's own `env_key` indirection (codex reads the
// named env var at request time); placeholder expansion exists for fields that
// must carry a literal value (e.g. http_headers). Unresolvable placeholders are
// left intact.
function expandEnvPlaceholders<T>(value: T, resolve: (name: string) => string | undefined): T {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const resolved = resolve(name);
      return resolved !== undefined && resolved.length > 0 ? resolved : match;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvPlaceholders(entry, resolve)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = expandEnvPlaceholders(entry, resolve);
    }
    return out as unknown as T;
  }
  return value;
}

// PAPERCLIP_CODEX_PROVIDERS is a JSON object that maps 1:1 onto codex's
// config.toml schema:
//
//   {
//     "providers": {
//       "<id>": {                      // -> [model_providers.<id>]
//         "name": "My gateway",        // optional display name
//         "base_url": "http://...",    // OpenAI-compatible endpoint
//         "env_key": "OPENAI_API_KEY", // env var codex reads the bearer key from
//         "wire_api": "responses",     // protocol codex speaks to the provider
//         ...                          // any other field codex supports
//         //                              (query_params, http_headers,
//         //                               env_http_headers, request_max_retries, ...)
//       }
//     },
//     "model_provider": "<id>"         // optional: top-level provider selection
//   }
//
// Scalar fields are emitted verbatim as TOML key = value pairs; plain-object
// fields (query_params, http_headers, ...) are emitted as inline tables and
// arrays of scalars as TOML arrays. String values may use {env:VAR}
// placeholders, expanded server-side against the run env and process.env.
function parseCodexProvidersConfig(
  raw: unknown,
  resolveEnv: (name: string) => string | undefined,
  notes: string[],
): ParsedCodexProvidersConfig | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Surface the misconfiguration instead of silently dropping the provider
    // config; an unparseable value would otherwise be undiagnosable.
    notes.push("PAPERCLIP_CODEX_PROVIDERS contains invalid JSON; custom providers ignored.");
    return null;
  }
  if (!isPlainObject(parsed)) {
    notes.push("PAPERCLIP_CODEX_PROVIDERS is set but is not a JSON object; custom providers ignored.");
    return null;
  }
  const rawProviders = parsed.providers;
  if (!isPlainObject(rawProviders)) {
    notes.push(
      'PAPERCLIP_CODEX_PROVIDERS has no "providers" object; custom providers ignored.',
    );
    return null;
  }
  // Only keep provider entries with non-empty names and object values; surface
  // the ones we drop so a malformed entry is just as diagnosable as malformed JSON.
  const providers: Record<string, Record<string, unknown>> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(rawProviders)) {
    if (key.trim().length === 0 || !isPlainObject(value)) {
      skipped.push(key.trim().length === 0 ? "(empty name)" : key);
      continue;
    }
    providers[key] = expandEnvPlaceholders(value, resolveEnv);
  }
  if (Object.keys(providers).length === 0) {
    notes.push(
      `PAPERCLIP_CODEX_PROVIDERS "providers" contains no usable entries${
        skipped.length > 0
          ? ` (skipped provider(s) with empty names or non-object values: ${skipped.join(", ")})`
          : ""
      }; custom providers ignored.`,
    );
    return null;
  }
  if (skipped.length > 0) {
    notes.push(
      `PAPERCLIP_CODEX_PROVIDERS: skipped provider(s) with empty names or non-object values: ${skipped.join(", ")}.`,
    );
  }
  const modelProvider =
    typeof parsed.model_provider === "string" && parsed.model_provider.trim().length > 0
      ? parsed.model_provider.trim()
      : null;
  // A selector pointing at a provider that did not survive filtering (or was
  // never defined) would emit model_provider = "x" with no [model_providers.x]
  // table, which codex rejects at runtime with an error that points nowhere
  // near the env var. Treat it as the same class of misconfiguration as
  // malformed JSON: reject the whole block with a visible note.
  if (modelProvider !== null && !(modelProvider in providers)) {
    notes.push(
      `PAPERCLIP_CODEX_PROVIDERS: model_provider "${modelProvider}" does not match any usable provider entry; custom providers ignored.`,
    );
    return null;
  }
  return { providers, modelProvider };
}

function escapeTomlString(value: string): string {
  // TOML 1.0 basic strings require escaping U+0000-U+001F and U+007F (DEL).
  return value.replace(/[\\"\u0000-\u001f\u007f]/g, (char) => {
    switch (char) {
      case "\\":
        return "\\\\";
      case '"':
        return '\\"';
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  });
}

const BARE_TOML_KEY_RE = /^[A-Za-z0-9_-]+$/;

function tomlKey(key: string): string {
  return BARE_TOML_KEY_RE.test(key) ? key : `"${escapeTomlString(key)}"`;
}

// Hand-emitted TOML for a constrained value space (strings, numbers, booleans,
// arrays of scalars, plain objects as inline tables). Returns null for values
// that cannot be represented, which are then skipped.
function tomlValue(value: unknown): string | null {
  if (typeof value === "string") return `"${escapeTomlString(value)}"`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (Array.isArray(value)) {
    const entries = value.map((entry) => tomlValue(entry));
    if (entries.some((entry) => entry === null)) return null;
    return `[${entries.join(", ")}]`;
  }
  if (isPlainObject(value)) {
    const pairs: string[] = [];
    for (const [key, entry] of Object.entries(value)) {
      const emitted = tomlValue(entry);
      if (emitted === null) continue;
      pairs.push(`${tomlKey(key)} = ${emitted}`);
    }
    return `{ ${pairs.join(", ")} }`;
  }
  return null;
}

function emitProviderTable(name: string, fields: Record<string, unknown>): string[] {
  const lines = [`[model_providers.${tomlKey(name)}]`];
  for (const [key, value] of Object.entries(fields)) {
    const emitted = tomlValue(value);
    if (emitted === null) continue;
    lines.push(`${tomlKey(key)} = ${emitted}`);
  }
  return lines;
}

function stripManagedBlock(lines: string[], begin: string, end: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inBlock && trimmed === begin) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (trimmed === end) inBlock = false;
      continue;
    }
    out.push(line);
  }
  return out;
}

export function stripManagedCodexProviderBlocks(content: string): string {
  let lines = content.split("\n");
  lines = stripManagedBlock(lines, MANAGED_ROOT_BEGIN, MANAGED_ROOT_END);
  lines = stripManagedBlock(lines, MANAGED_TABLES_BEGIN, MANAGED_TABLES_END);
  return lines.join("\n");
}

const TABLE_HEADER_RE = /^\s*\[\s*([^\]]*?)\s*\]\s*(?:#.*)?$/;

// Best-effort parse of a TOML table header into its dotted path segments,
// stripping surrounding quotes per segment. Dotted quoted segment names are
// out of scope for this merge (codex provider ids are simple identifiers).
function parseTableHeaderPath(line: string): string[] | null {
  const match = TABLE_HEADER_RE.exec(line);
  if (!match) return null;
  return match[1]
    .split(".")
    .map((segment) => segment.trim())
    .map((segment) => segment.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
}

// Remove pre-existing definitions that would conflict with (or override) the
// managed content: [model_providers.<name>] tables (and their subtables) for
// names we are about to define, and the root-level `model_provider` key when
// we set one. Duplicate TOML tables/keys are parse errors in codex, so the
// managed definitions must win by excising the originals.
function stripConflictingDefinitions(
  content: string,
  providerNames: string[],
  removeRootModelProvider: boolean,
): string {
  const names = new Set(providerNames);
  const lines = content.split("\n");
  const out: string[] = [];
  let inRootRegion = true;
  let skippingSection = false;
  for (const line of lines) {
    const headerPath = parseTableHeaderPath(line);
    if (headerPath) {
      inRootRegion = false;
      skippingSection =
        headerPath.length >= 2 &&
        headerPath[0] === "model_providers" &&
        names.has(headerPath[1]);
      if (skippingSection) continue;
    } else if (skippingSection) {
      continue;
    }
    if (inRootRegion && removeRootModelProvider && /^\s*model_provider\s*=/.test(line)) {
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function buildMergedConfigToml(base: string, parsed: ParsedCodexProvidersConfig): string {
  const sections: string[] = [];
  if (parsed.modelProvider) {
    sections.push(
      [
        MANAGED_ROOT_BEGIN,
        `model_provider = "${escapeTomlString(parsed.modelProvider)}"`,
        MANAGED_ROOT_END,
      ].join("\n"),
    );
  }
  const trimmedBase = base.replace(/^\n+/, "").replace(/\n+$/, "");
  if (trimmedBase.length > 0) sections.push(trimmedBase);
  const tableLines: string[] = [MANAGED_TABLES_BEGIN];
  for (const [name, fields] of Object.entries(parsed.providers)) {
    tableLines.push(...emitProviderTable(name, fields), "");
  }
  while (tableLines[tableLines.length - 1] === "") tableLines.pop();
  tableLines.push(MANAGED_TABLES_END);
  sections.push(tableLines.join("\n"));
  return `${sections.join("\n\n")}\n`;
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  return fs.readFile(filePath, "utf8").catch(() => null);
}

export type CodexProviderEnvKeySelection = {
  /** Value of the root-level `model_provider` key. */
  modelProvider: string;
  /** `env_key` declared by that provider's `[model_providers.<id>]` table. */
  envKey: string;
};

// A quoted scalar assignment on its own line: `key = "value"` or `key = 'value'`,
// with an optional trailing comment. Deliberately narrow -- anything else (inline
// tables, multi-line strings) yields no selection, which disables the check
// rather than guessing.
const ROOT_MODEL_PROVIDER_RE = /^\s*model_provider\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/;
const ENV_KEY_RE = /^\s*env_key\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/;

function readQuotedAssignment(line: string, pattern: RegExp): string | null {
  const match = pattern.exec(line);
  if (!match) return null;
  const value = (match[1] ?? match[2] ?? "").trim();
  return value.length > 0 ? value : null;
}

// Best-effort read of the *effective* provider selection from config.toml text:
// the root-level `model_provider`, plus the `env_key` its [model_providers.<id>]
// table declares. Codex reads that env var at request time and aborts the run
// when it is unset, so the pair is exactly what a pre-flight check needs.
//
// Deliberately a text scan rather than a real TOML parse: the merge code above
// already reasons about this file line-by-line, the adapter carries no TOML
// dependency, and every consumer of this function treats "no selection found"
// as "nothing to check". A parse this narrow can only under-report.
export function readSelectedProviderEnvKey(content: string): CodexProviderEnvKeySelection | null {
  const lines = content.split("\n");
  // TOML root-level keys must precede the first table header, so the search for
  // `model_provider` stops there; a `model_provider` inside a table is a
  // different key entirely (e.g. [profiles.x]) and must not be picked up.
  let modelProvider: string | null = null;
  for (const line of lines) {
    if (parseTableHeaderPath(line) !== null) break;
    modelProvider = readQuotedAssignment(line, ROOT_MODEL_PROVIDER_RE);
    if (modelProvider !== null) break;
  }
  if (modelProvider === null) return null;

  let inSelectedTable = false;
  for (const line of lines) {
    const headerPath = parseTableHeaderPath(line);
    if (headerPath !== null) {
      // Exactly [model_providers.<id>] -- a subtable such as
      // [model_providers.<id>.http_headers] does not carry the provider's env_key.
      inSelectedTable =
        headerPath.length === 2 &&
        headerPath[0] === "model_providers" &&
        headerPath[1] === modelProvider;
      continue;
    }
    if (!inSelectedTable) continue;
    const envKey = readQuotedAssignment(line, ENV_KEY_RE);
    if (envKey !== null) return { modelProvider, envKey };
  }
  return null;
}

// The selected provider's env_key when it resolves to nothing in the run env,
// else null. An env var set to whitespace is treated as unset: codex sends it as
// the bearer token and the provider rejects it, which is the same broken run
// with a less obvious symptom.
function findUnsetProviderEnvKey(
  content: string,
  resolveEnv: (name: string) => string | undefined,
): CodexProviderEnvKeySelection | null {
  const selection = readSelectedProviderEnvKey(content);
  if (selection === null) return null;
  const value = resolveEnv(selection.envKey);
  return value === undefined || value.trim().length === 0 ? selection : null;
}

// Codex's own failure here is `Missing environment variable: \`X\``, which names
// neither the config file the selection came from nor the setting that put it
// there. Name all three.
function describeUnsetProviderEnvKey(
  selection: CodexProviderEnvKeySelection,
  configTomlPath: string,
): string {
  return (
    `Codex model_provider "${selection.modelProvider}" declares env_key "${selection.envKey}" in ` +
    `"${configTomlPath}", but ${selection.envKey} is unset or empty in this run's environment. ` +
    `Codex would fail with "Missing environment variable: \`${selection.envKey}\`". ` +
    `Set ${selection.envKey} in the agent's adapter config env (or bind it as a secret), ` +
    `or select a provider that does not need it via PAPERCLIP_CODEX_PROVIDERS.`
  );
}

// Pre-run backup of the original config.toml, written before the merged file.
// If a run dies without reaching cleanup() (a setup throw between prepare and
// execution, SIGKILL, ...), the next prepare restores the original from this
// backup with full fidelity -- including user [model_providers.*] sections the
// merge excised, which block-stripping alone cannot bring back.
function configTomlBackupPath(configTomlPath: string): string {
  return `${configTomlPath}.paperclip-backup`;
}

// Merge custom Codex model providers supplied via PAPERCLIP_CODEX_PROVIDERS
// into the managed CODEX_HOME's config.toml.
//
// Codex has no CLI flag or env var for pointing at a custom OpenAI-compatible
// endpoint: custom endpoints are `[model_providers.<id>]` tables in
// $CODEX_HOME/config.toml, selected by a top-level `model_provider = "<id>"`
// key (the `--model` CLI flag picks the model WITHIN the selected provider).
// We accept the providers as config (not hard-coded) so the gateway URL, key
// indirection, and wire protocol stay declarative.
//
// The merge preserves any existing config.toml content (seeded from the shared
// ~/.codex by prepareManagedCodexHome): managed content lives between marker
// comments and conflicting pre-existing definitions are excised so the managed
// definitions win. cleanup() restores the original file; if a run dies before
// cleanup, the next prepare restores the original from the pre-run backup file
// written alongside config.toml (including when PAPERCLIP_CODEX_PROVIDERS is
// no longer set), falling back to stripping the stale managed blocks.
//
// When the adapter config explicitly sets env.CODEX_HOME (a user-managed home),
// pass codexHome: null -- the file is left untouched and a note is surfaced.
export async function prepareCodexRuntimeConfig(input: {
  env: Record<string, string>;
  codexHome: string | null;
  /**
   * The explicitly configured `env.CODEX_HOME` when there is one (`codexHome` is
   * null in that case). Read-only: its config.toml is inspected for diagnostics
   * and never seeded, merged, or rewritten.
   */
  externalCodexHome?: string | null;
  /**
   * True when the codex process will run on a remote execution target. The
   * control plane's `process.env` is not that process's environment, so the
   * selected-provider env_key check degrades to a warning instead of failing
   * a run whose env we cannot actually see.
   */
  executionTargetIsRemote?: boolean;
}): Promise<PreparedCodexRuntimeConfig> {
  // Two different questions, two resolvers -- conflating them is what makes the
  // pre-flight check lie.
  //
  // `resolveEnv` answers "what should this {env:VAR} placeholder expand to?".
  // The expansion is baked into config.toml here on the control plane and
  // travels with the file, so the control plane's own process.env is a
  // legitimate source even for a run that executes elsewhere.
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  // `resolveRunEnv` answers the narrower question the env_key check needs:
  // "will the codex process itself see a value for this variable?". The spawned
  // child's environment is `sanitizeInheritedPaperclipEnv(process.env)` with the
  // adapter config env layered on top (runChildProcess in adapter-utils) -- note
  // the sanitize step, which drops PAPERCLIP_*, so a provider whose env_key uses
  // that prefix is NOT satisfied by the host process env.
  //
  // A remote target inherits none of it: only the explicit env record crosses
  // the transport (sanitizeRemoteExecutionEnv + buildSshSpawnTarget), so the
  // control plane's process.env is not evidence of anything. Its own login
  // profile may still supply the value and we cannot read it from here, which is
  // why a miss on a remote target warns rather than fails.
  const inheritedEnv: NodeJS.ProcessEnv = input.executionTargetIsRemote
    ? {}
    : sanitizeInheritedPaperclipEnv(process.env);
  const resolveRunEnv = (name: string): string | undefined => input.env[name] ?? inheritedEnv[name];
  const notes: string[] = [];
  const parsed = parseCodexProvidersConfig(
    input.env.PAPERCLIP_CODEX_PROVIDERS ?? process.env.PAPERCLIP_CODEX_PROVIDERS,
    resolveEnv,
    notes,
  );

  // An explicitly configured CODEX_HOME is never merged into or rewritten, but
  // its config can still select a provider whose env_key is unset. Reading it is
  // free and warning beats letting codex die on its first model refresh -- but
  // the merge is off for this home, so a warning is as far as it goes.
  if (input.externalCodexHome) {
    const externalConfigTomlPath = path.join(input.externalCodexHome, "config.toml");
    const externalConfig = await readFileOrNull(externalConfigTomlPath);
    const unset =
      externalConfig === null ? null : findUnsetProviderEnvKey(externalConfig, resolveRunEnv);
    if (unset) {
      notes.push(
        `Warning: ${describeUnsetProviderEnvKey(unset, externalConfigTomlPath)} ` +
          `Paperclip does not merge model providers into an explicitly configured CODEX_HOME, ` +
          `so it is leaving this file as-is.`,
      );
    }
  }

  if (!parsed) {
    // Self-heal state left behind by a crashed run (cleanup() never ran).
    if (input.codexHome) {
      const configTomlPath = path.join(input.codexHome, "config.toml");
      const reason = notes.length === 0 ? " (PAPERCLIP_CODEX_PROVIDERS is no longer set)" : "";
      const backupPath = configTomlBackupPath(configTomlPath);
      const backup = await readFileOrNull(backupPath);
      if (backup !== null) {
        // Full-fidelity restore: the backup is the pre-run original, including
        // any user provider sections the crashed run's merge excised.
        await fs.writeFile(configTomlPath, backup, "utf8");
        await fs.rm(backupPath, { force: true });
        return {
          notes: [
            ...notes,
            `Restored "${configTomlPath}" from its pre-run backup, removing stale Paperclip-managed model providers left by an interrupted run${reason}.`,
          ],
          cleanup: async () => {},
        };
      }
      // Fallback for pre-backup stale state: strip the managed blocks.
      const existing = await readFileOrNull(configTomlPath);
      if (existing !== null) {
        const stripped = stripManagedCodexProviderBlocks(existing);
        if (stripped !== existing) {
          await fs.writeFile(configTomlPath, stripped, "utf8");
          return {
            notes: [
              ...notes,
              `Removed stale Paperclip-managed model provider blocks from "${configTomlPath}"${reason}.`,
            ],
            cleanup: async () => {},
          };
        }
      }
    }
    return { notes, cleanup: async () => {} };
  }

  if (!input.codexHome) {
    return {
      notes: [
        ...notes,
        "PAPERCLIP_CODEX_PROVIDERS is set but the adapter config explicitly sets env.CODEX_HOME; leaving the user-managed Codex home untouched (no model provider merge).",
      ],
      cleanup: async () => {},
    };
  }

  const configTomlPath = path.join(input.codexHome, "config.toml");
  const backupPath = configTomlBackupPath(configTomlPath);
  // A surviving backup from an interrupted run is the true pre-run content;
  // the current config.toml would still carry that run's managed blocks.
  const original = (await readFileOrNull(backupPath)) ?? (await readFileOrNull(configTomlPath));
  const providerNames = Object.keys(parsed.providers);
  const base = stripConflictingDefinitions(
    stripManagedCodexProviderBlocks(original ?? ""),
    providerNames,
    parsed.modelProvider !== null,
  );
  const merged = buildMergedConfigToml(base, parsed);

  // The selection can come from either side of the merge -- PAPERCLIP_CODEX_PROVIDERS'
  // own `model_provider`, or a root key already in the base config -- so the check
  // runs against the merged result rather than the parsed input. A run whose
  // selected provider names an unset env_key is guaranteed to die inside codex;
  // fail here, where the error can name the provider, the env var, and the file.
  // Nothing has been written yet, so a throw leaves the home exactly as it was.
  const unsetEnvKey = findUnsetProviderEnvKey(merged, resolveRunEnv);
  if (unsetEnvKey) {
    if (input.executionTargetIsRemote) {
      notes.push(
        `Warning: ${describeUnsetProviderEnvKey(unsetEnvKey, configTomlPath)} ` +
          `This run targets a remote execution host: the control plane's own environment does ` +
          `not cross the transport, so ${unsetEnvKey.envKey} has to come from the adapter config ` +
          `env or from the remote host's own login profile -- which Paperclip cannot read from ` +
          `here, so this is a warning rather than a hard failure.`,
      );
    } else {
      throw new Error(describeUnsetProviderEnvKey(unsetEnvKey, configTomlPath));
    }
  }

  await fs.mkdir(input.codexHome, { recursive: true });
  // Persist the original BEFORE writing the merged file so a run that never
  // reaches cleanup() can be restored by the next prepare.
  await fs.writeFile(backupPath, original ?? "", "utf8");
  await fs.writeFile(configTomlPath, merged, "utf8");

  return {
    notes: [
      ...notes,
      `Merged ${providerNames.length} custom Codex model provider(s) from PAPERCLIP_CODEX_PROVIDERS into "${configTomlPath}": ${providerNames.join(", ")}${
        parsed.modelProvider ? `; selected model_provider "${parsed.modelProvider}"` : ""
      }.`,
    ],
    cleanup: async () => {
      if (original === null) {
        await fs.rm(configTomlPath, { force: true });
      } else {
        await fs.writeFile(configTomlPath, original, "utf8");
      }
      await fs.rm(backupPath, { force: true });
    },
  };
}
