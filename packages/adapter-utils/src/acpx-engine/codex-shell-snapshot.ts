import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

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

// TOML keys may be bare (`shell_snapshot`) or quoted (`"shell_snapshot"`,
// `'shell_snapshot'`); a rewriter that only matches the bare form silently
// ignores a quoted `[features]` table or a quoted `shell_snapshot` key and
// goes on to append a second, colliding `[features]` table — TOML-invalid,
// and it breaks every Codex run reading the file.
const BARE_KEY = "[A-Za-z0-9_-]+";
const DOUBLE_QUOTED_KEY = '"(?:[^"\\\\]|\\\\.)*"';
const SINGLE_QUOTED_KEY = "'[^']*'";
const KEY_TOKEN = `(?:${DOUBLE_QUOTED_KEY}|${SINGLE_QUOTED_KEY}|${BARE_KEY})`;

function unquoteKey(token: string): string {
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1);
  }
  return token;
}

// A trailing `# comment` after the closing bracket is valid TOML; a previous
// anchored-to-end-of-line regex missed it and fell through to appending a
// second, TOML-invalid `[features]` table onto an already-valid config.
const TABLE_HEADER_NAME = new RegExp(`^\\s*\\[\\s*(${KEY_TOKEN})\\s*\\]\\s*(#.*)?$`);
const ASSIGNMENT_KEY = new RegExp(`^\\s*(${KEY_TOKEN})\\s*=`);
const DOTTED_KEY_ASSIGNMENT = new RegExp(`^\\s*(${KEY_TOKEN})\\s*\\.\\s*(${KEY_TOKEN})\\s*=`);

function isFeaturesTableHeader(line: string): boolean {
  const match = TABLE_HEADER_NAME.exec(line);
  return match !== null && unquoteKey(match[1]) === "features";
}

function isShellSnapshotAssignment(line: string): boolean {
  const match = ASSIGNMENT_KEY.exec(line);
  return match !== null && unquoteKey(match[1]) === "shell_snapshot";
}

function isDottedShellSnapshotAssignment(line: string): boolean {
  const match = DOTTED_KEY_ASSIGNMENT.exec(line);
  return match !== null && unquoteKey(match[1]) === "features" && unquoteKey(match[2]) === "shell_snapshot";
}

function isFeaturesInlineTableAssignment(line: string): boolean {
  if (isDottedShellSnapshotAssignment(line)) return false;
  const match = ASSIGNMENT_KEY.exec(line);
  return match !== null && unquoteKey(match[1]) === "features";
}

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
  // table anyway would make the file unparseable. Report and leave it alone —
  // unless the inline table already sets `shell_snapshot = false`, in which
  // case the policy is already in force and there is nothing to enforce; a
  // config an operator already locked down should not block every launch.
  const inlineIndex = lines.findIndex((line) => isFeaturesInlineTableAssignment(line));
  if (inlineIndex >= 0) {
    if (inlineFeaturesAlreadyDisableShellSnapshot(withoutManagedBlock)) {
      return { text: configToml, changed: false };
    }
    return {
      text: configToml,
      changed: false,
      unsupported: `config.toml line ${inlineIndex + 1} defines "features" as an inline table`,
    };
  }

  const headerIndex = lines.findIndex((line) => isFeaturesTableHeader(line));
  const next = headerIndex >= 0
    ? setKeyInFeaturesTable(lines, headerIndex)
    : appendManagedBlock(lines);

  if (next === configToml) {
    return { text: next, changed: false };
  }

  // The rewrite above is line-oriented, not a real TOML parser — quoting,
  // nesting or an operator table shape it didn't anticipate can still turn
  // valid input into invalid output. Codex reads this file at startup, so
  // parse the candidate before it ever replaces the file on disk; a rewrite
  // that doesn't parse is reported, not written.
  try {
    parseToml(next);
  } catch (err) {
    return {
      text: configToml,
      changed: false,
      unsupported: `rewriting config.toml would produce invalid TOML: ${errorText(err)}`,
    };
  }

  return { text: next, changed: true };
}

// Whether an inline `features = { ... }` table this rewriter will not touch
// already disables shell snapshots, so blocking the launch would gate a
// config that is already policy-compliant on this rewriter's TOML support.
// A config that fails to parse is not "already disabled" — the caller's own
// read/enforcement path is the one that reports the parse failure.
function inlineFeaturesAlreadyDisableShellSnapshot(configToml: string): boolean {
  try {
    const parsed = parseToml(configToml) as { features?: { shell_snapshot?: unknown } };
    return parsed.features?.shell_snapshot === false;
  } catch {
    return false;
  }
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
    if (isDottedShellSnapshotAssignment(line)) continue;
    if (index === headerIndex) {
      insideFeatures = true;
      result.push(line, MANAGED_KEY_COMMENT, "shell_snapshot = false");
      continue;
    }
    if (insideFeatures && TABLE_HEADER.test(line)) insideFeatures = false;
    if (insideFeatures && isShellSnapshotAssignment(line)) continue;
    // A managed comment from a previous run sits right above the key it
    // documents. Drop it too, or every re-run appends another copy.
    if (insideFeatures && line === MANAGED_KEY_COMMENT) continue;
    result.push(line);
  }
  return ensureTrailingNewline(result.join("\n"));
}

function appendManagedBlock(lines: string[]): string {
  const body = lines.join("\n").replace(/\n+$/, "");
  const withoutDottedKey = body
    .split("\n")
    .filter((line) => !isDottedShellSnapshotAssignment(line))
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
 * Thrown when the shell-snapshot policy cannot be guaranteed for a Codex
 * launch. The caller must not launch Codex when this is thrown: a snapshot
 * written before the policy is confirmed in force would record this run's
 * credentials to disk in plaintext, so an unreadable/unwritable/unsupported
 * config blocks the launch instead of warning and proceeding anyway.
 */
export class CodexShellSnapshotPolicyError extends Error {}

/**
 * Apply the shell-snapshot policy to a Codex home's `config.toml` in place.
 * Creates the file when the home has none. Returns the lines to report on the
 * run log; an empty array means the policy was already in force. Throws
 * {@link CodexShellSnapshotPolicyError} rather than launching Codex unprotected.
 */
export async function enforceCodexShellSnapshotPolicy(codexHome: string): Promise<string[]> {
  const configPath = path.join(codexHome, "config.toml");
  let current = "";
  // `config.toml` can carry literal provider secrets (expanded env vars in
  // `[model_providers]` env_key entries). Always write it back owner-only,
  // whatever mode it had before — a rewrite is exactly the moment to correct
  // a config.toml an operator or seed step left group- or world-readable,
  // not to carry that exposure forward.
  try {
    current = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if (!isMissingFile(err)) {
      throw new CodexShellSnapshotPolicyError(
        `Could not read "${configPath}" to enforce the Codex shell-snapshot policy: ${errorText(err)}. ` +
          "Refusing to launch Codex without snapshot protection.",
      );
    }
  }

  const policy = applyShellSnapshotPolicy(current);
  if (policy.unsupported) {
    throw new CodexShellSnapshotPolicyError(
      `Cannot enforce the Codex shell-snapshot policy: ${policy.unsupported}. ` +
        `Set features.shell_snapshot = false in "${configPath}" by hand, then retry — ` +
        "refusing to launch Codex without snapshot protection.",
    );
  }
  if (!policy.changed) return [];

  try {
    await fs.mkdir(codexHome, { recursive: true });
    // A PID-only suffix collides between concurrent runs sharing one company
    // Codex home: one writer's rename can land on the other's still-open temp
    // file. A random suffix per invocation makes the temp path unique instead.
    const tempPath = `${configPath}.paperclip-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(tempPath, policy.text, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, configPath);
  } catch (err) {
    throw new CodexShellSnapshotPolicyError(
      `Could not write "${configPath}" to enforce the Codex shell-snapshot policy: ${errorText(err)}. ` +
        "Refusing to launch Codex without snapshot protection.",
    );
  }
  return [
    `[paperclip] Disabled Codex shell snapshots in "${configPath}" (they record the launch environment, credentials included).`,
  ];
}

function isMissingFile(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
