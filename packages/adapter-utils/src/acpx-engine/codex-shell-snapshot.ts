import fs from "node:fs/promises";
import path from "node:path";
import { ensureRestrictedDir, writeRestrictedFile } from "./restricted-files.js";

/**
 * Codex shell snapshots serialize the provider process environment into
 * `$CODEX_HOME/shell_snapshots/*.sh` as `declare -x NAME="value"` lines. The
 * ACPX engine passes this run's bound secrets in that environment, so a snapshot
 * turns an ephemeral credential into durable, plaintext, per-seat state — the
 * same defect as a persisted session record, on a different file (KEE-192).
 *
 * The native runner already pins `features.shell_snapshot = false` in the Codex
 * homes it materializes (`prepareIsolatedCodexHome`,
 * `writeAcpxAgentHomeConfig`). The ACPX engine's managed company Codex home is
 * seeded by copying the operator's `~/.codex/config.toml`, which carries no such
 * policy, so it snapshots on every run. This module applies the same policy to
 * the engine's effective Codex home.
 */
const MANAGED_BEGIN = "# >>> paperclip codex runtime policy -- managed, do not edit >>>";
const MANAGED_END = "# <<< paperclip codex runtime policy <<<";

const MANAGED_BLOCK = [
  MANAGED_BEGIN,
  // Keep the reason in the file: the next person to read this Codex home should
  // not have to guess why a performance optimization is off.
  "# Codex shell snapshots record the provider launch environment, including",
  "# this run's bound credentials, as durable plaintext. Paperclip keeps them off.",
  "[features]",
  "shell_snapshot = false",
  MANAGED_END,
].join("\n");

const MANAGED_KEY_COMMENT =
  "# managed by paperclip: the launch environment must not be snapshotted";

const TABLE_HEADER = /^\s*\[/;
const FEATURES_TABLE_HEADER = /^\s*\[\s*features\s*\]\s*$/;
const SHELL_SNAPSHOT_KEY = /^\s*shell_snapshot\s*=/;
const DOTTED_SHELL_SNAPSHOT_KEY = /^\s*features\s*\.\s*shell_snapshot\s*=/;
const FEATURES_INLINE_TABLE = /^\s*features\s*=/;

export type ShellSnapshotPolicyResult = {
  /** The config text with the policy applied, or the input unchanged. */
  text: string;
  /** True when `text` differs from the input. */
  changed: boolean;
  /**
   * Set when the existing config uses a shape this rewriter will not touch. The
   * caller reports it instead of writing a file that would break every Codex
   * run; nothing is silently dropped.
   */
  unsupported?: string;
};

/**
 * Enforce `features.shell_snapshot = false` in a Codex `config.toml`, preserving
 * every other setting and staying idempotent across runs.
 */
export function applyShellSnapshotPolicy(configToml: string): ShellSnapshotPolicyResult {
  // Drop a previously written managed block first, so a re-run rewrites it in
  // place rather than appending a second (TOML-invalid) `[features]` table.
  const withoutManagedBlock = removeManagedBlock(configToml);

  const lines = withoutManagedBlock.length > 0 ? withoutManagedBlock.split("\n") : [];

  // An inline `features = { ... }` root assignment cannot be merged with a
  // `[features]` table without reimplementing a TOML parser, and appending the
  // table anyway would make the file unparseable. Report and leave it alone.
  const inlineIndex = lines.findIndex(
    (line) => FEATURES_INLINE_TABLE.test(line) && !DOTTED_SHELL_SNAPSHOT_KEY.test(line),
  );
  if (inlineIndex >= 0) {
    return {
      text: configToml,
      changed: false,
      unsupported: `config.toml line ${inlineIndex + 1} defines "features" as an inline table`,
    };
  }

  const headerIndex = lines.findIndex((line) => FEATURES_TABLE_HEADER.test(line));
  const next = headerIndex >= 0
    ? setKeyInFeaturesTable(lines, headerIndex)
    : appendManagedBlock(lines);

  return { text: next, changed: next !== configToml };
}

function removeManagedBlock(configToml: string): string {
  const begin = configToml.indexOf(MANAGED_BEGIN);
  if (begin < 0) return configToml;
  const end = configToml.indexOf(MANAGED_END, begin);
  if (end < 0) return configToml;
  const head = configToml.slice(0, begin).replace(/\n+$/, "");
  const tail = configToml.slice(end + MANAGED_END.length).replace(/^\n+/, "");
  if (head.length === 0) return tail;
  if (tail.length === 0) return head.length > 0 ? `${head}\n` : "";
  return `${head}\n${tail}`;
}

// The operator's config already has a `[features]` table. Put the key inside it
// rather than declaring the table twice, and drop any competing value — a
// duplicate key is a TOML error, and a later `shell_snapshot = true` would win.
function setKeyInFeaturesTable(lines: string[], headerIndex: number): string {
  const result: string[] = [];
  let insideFeatures = false;
  for (const [index, line] of lines.entries()) {
    // A root-level `features.shell_snapshot = ...` dotted key collides with the
    // table key below, so it goes wherever it sits in the file.
    if (DOTTED_SHELL_SNAPSHOT_KEY.test(line)) continue;
    if (index === headerIndex) {
      insideFeatures = true;
      result.push(line, MANAGED_KEY_COMMENT, "shell_snapshot = false");
      continue;
    }
    if (insideFeatures && TABLE_HEADER.test(line)) insideFeatures = false;
    if (insideFeatures && SHELL_SNAPSHOT_KEY.test(line)) continue;
    result.push(line);
  }
  return ensureTrailingNewline(result.join("\n"));
}

function appendManagedBlock(lines: string[]): string {
  const body = lines.join("\n").replace(/\n+$/, "");
  const withoutDottedKey = body
    .split("\n")
    .filter((line) => !DOTTED_SHELL_SNAPSHOT_KEY.test(line))
    .join("\n")
    .replace(/\n+$/, "");
  // A TOML table header swallows every root key that follows it, so the managed
  // table has to go at the end of the file, never the top.
  const joined = withoutDottedKey.length > 0
    ? `${withoutDottedKey}\n\n${MANAGED_BLOCK}`
    : MANAGED_BLOCK;
  return ensureTrailingNewline(joined);
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Apply the shell-snapshot policy to a Codex home's `config.toml` in place.
 * Creates the file when the home has none. Returns the lines to report on the
 * run log; an empty array means the policy was already in force.
 */
export async function enforceCodexShellSnapshotPolicy(codexHome: string): Promise<string[]> {
  const configPath = path.join(codexHome, "config.toml");
  // Runs before the policy is read, and on every call rather than only when the
  // config changes. Any `shell_snapshots/*.sh` a Codex run wrote before this
  // policy existed is still sitting in this home, and Codex — not Paperclip —
  // creates those files, so their own mode is out of reach. A private home is
  // the only thing that keeps them from other accounts on the host.
  const notes = await ensureRestrictedDir(codexHome);

  let current = "";
  try {
    current = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if (!isMissingFile(err)) {
      return [
        ...notes,
        `[paperclip] Could not read "${configPath}" to disable Codex shell snapshots: ${errorText(err)}`,
      ];
    }
  }

  const policy = applyShellSnapshotPolicy(current);
  if (policy.unsupported) {
    return [
      ...notes,
      `[paperclip] Left Codex shell snapshots enabled: ${policy.unsupported}. ` +
        "Set features.shell_snapshot = false there by hand — snapshots record this run's credentials to disk.",
    ];
  }
  if (!policy.changed) return notes;

  try {
    const tempPath = `${configPath}.paperclip-${process.pid}.tmp`;
    // Written at 0600 and renamed into place: the config carries whatever the
    // operator's seed carried, and a mode set after the write would leave a
    // world-readable window in between.
    await writeRestrictedFile(tempPath, policy.text);
    await fs.rename(tempPath, configPath);
  } catch (err) {
    return [
      ...notes,
      `[paperclip] Could not write "${configPath}" to disable Codex shell snapshots: ${errorText(err)}`,
    ];
  }
  return [
    ...notes,
    `[paperclip] Disabled Codex shell snapshots in "${configPath}" (they record the launch environment, credentials included).`,
  ];
}

function isMissingFile(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
