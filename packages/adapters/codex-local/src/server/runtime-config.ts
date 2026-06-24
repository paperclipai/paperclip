import fs from "node:fs/promises";
import path from "node:path";

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
}): Promise<PreparedCodexRuntimeConfig> {
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const notes: string[] = [];
  const parsed = parseCodexProvidersConfig(
    input.env.PAPERCLIP_CODEX_PROVIDERS ?? process.env.PAPERCLIP_CODEX_PROVIDERS,
    resolveEnv,
    notes,
  );

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
  await fs.mkdir(input.codexHome, { recursive: true });
  // Persist the original BEFORE writing the merged file so a run that never
  // reaches cleanup() can be restored by the next prepare.
  await fs.writeFile(backupPath, original ?? "", "utf8");
  await fs.writeFile(configTomlPath, buildMergedConfigToml(base, parsed), "utf8");

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
