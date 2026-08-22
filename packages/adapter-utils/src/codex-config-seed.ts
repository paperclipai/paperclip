import fs from "node:fs/promises";
import path from "node:path";

/**
 * Sanitizer for `config.toml` as it is seeded from a host Codex home into a
 * Paperclip-managed `CODEX_HOME`.
 *
 * A managed home is *derived state*: Paperclip creates it by copying the static
 * config files out of the host home (`$CODEX_HOME`, else `~/.codex`). That copy
 * is what makes model/provider selection dangerous to inherit, because Paperclip
 * already owns both:
 *
 * - the **model** is passed explicitly as `--model <id>` (built from
 *   `adapterConfig.model`), and when the agent configures none, the deliberate
 *   intent is "let the Codex CLI pick its default";
 * - the **provider** is selected only by the Paperclip-managed `model_provider`
 *   block that `PAPERCLIP_CODEX_PROVIDERS` merges into the managed config.
 *
 * So a root-level `model` / `model_provider` inherited from the host is never
 * something Paperclip asked for, and it silently outranks both mechanisms. The
 * observed failure: a host config pinning a local OpenAI-compatible gateway
 * (`model_provider = "omlx"`, whose `[model_providers.omlx]` declares
 * `env_key = "OMLX_API_KEY"`) makes every managed run die with
 * `Missing environment variable: OMLX_API_KEY` — an error that names neither the
 * config file it came from nor the host home it was copied out of.
 *
 * Provider *definitions* (`[model_providers.*]` tables) are deliberately left
 * intact: they are inert unless something selects them, and preserving them keeps
 * the copy faithful for anyone who later selects one through a supported path.
 */

/** Root-level keys that select a model/provider and must not be inherited. */
const INHERITED_SELECTION_KEYS = new Set(["model", "model_provider"]);

/**
 * A root-level key that can *indirectly* re-introduce a provider selection (a
 * `[profiles.<name>]` table may itself set `model_provider`). Not stripped —
 * a profile also carries policy a user may legitimately want — but reported so
 * the caller can surface it rather than let it fail opaquely later.
 */
const INDIRECT_SELECTION_KEY = "profile";

/**
 * Any line starting a table (`[table]`) or array-of-tables (`[[table]]`) header
 * ends the root region. Continuation lines of a multi-line root array can also
 * start with `[` (a nested array); ending the root region early there only makes
 * the sweep stop sooner, never strip something it should have kept.
 */
const TABLE_HEADER_START_RE = /^\s*\[/;

/**
 * A root-level assignment, capturing the key in whichever of TOML's three key
 * forms it uses (quoted, literal-quoted, bare) plus the raw value text.
 */
const ROOT_ASSIGNMENT_RE =
  /^\s*(?:"(?<quoted>[^"]*)"|'(?<literal>[^']*)'|(?<bare>[A-Za-z0-9_-]+))\s*=(?<value>.*)$/;

export interface SanitizedCodexSeedConfig {
  /** The config text with inherited selection keys removed. */
  content: string;
  /** Keys actually removed, in file order (may repeat if the source repeated them). */
  removedKeys: string[];
  /** True when a root-level `profile` key survived and could re-select a provider. */
  hasIndirectSelection: boolean;
}

/**
 * When a value opens a TOML multi-line string that does not close on the same
 * line, returns the delimiter that closes it; otherwise null. Used so stripping
 * an assignment also drops its continuation lines instead of leaving a dangling
 * `"""` that turns the whole file into a parse error.
 */
function readMultilineStringDelimiter(value: string): string | null {
  const trimmed = value.trim();
  for (const delimiter of ['"""', "'''"]) {
    if (!trimmed.startsWith(delimiter)) continue;
    return trimmed.slice(delimiter.length).includes(delimiter) ? null : delimiter;
  }
  return null;
}

/**
 * Removes root-level `model` / `model_provider` assignments from Codex
 * `config.toml` text. Content from the first table header onwards is returned
 * untouched, so `[model_providers.*]` definitions and every other table survive.
 */
export function stripInheritedCodexModelSelection(content: string): SanitizedCodexSeedConfig {
  const lines = content.split("\n");
  const out: string[] = [];
  const removedKeys: string[] = [];
  let inRootRegion = true;
  let hasIndirectSelection = false;
  // Set while skipping the continuation lines of a removed multi-line value.
  let closingDelimiter: string | null = null;

  for (const line of lines) {
    if (closingDelimiter !== null) {
      if (line.includes(closingDelimiter)) closingDelimiter = null;
      continue;
    }
    if (TABLE_HEADER_START_RE.test(line)) {
      inRootRegion = false;
      out.push(line);
      continue;
    }
    if (!inRootRegion) {
      out.push(line);
      continue;
    }

    const match = ROOT_ASSIGNMENT_RE.exec(line);
    const key = match?.groups?.quoted ?? match?.groups?.literal ?? match?.groups?.bare ?? null;
    if (key === INDIRECT_SELECTION_KEY) hasIndirectSelection = true;
    if (key === null || !INHERITED_SELECTION_KEYS.has(key)) {
      out.push(line);
      continue;
    }

    removedKeys.push(key);
    closingDelimiter = readMultilineStringDelimiter(match?.groups?.value ?? "");
  }

  return { content: out.join("\n"), removedKeys, hasIndirectSelection };
}

export interface CodexSeedSanitizationReport {
  removedKeys: string[];
  hasIndirectSelection: boolean;
}

const CODEX_CONFIG_FILE = "config.toml";

/**
 * True when both paths name the same directory. Compares real paths, not just
 * resolved strings: the host home reaches us as `$CODEX_HOME` or `~/.codex`,
 * either of which can be a symlink, and a plain string compare would then miss
 * the collision and let a "managed" seed write over the user's own config. Falls
 * back to the resolved strings when a path does not exist yet — the managed home
 * usually does not, and in that case it cannot be the host home either.
 */
async function isSameDirectory(left: string, right: string): Promise<boolean> {
  const [realLeft, realRight] = await Promise.all(
    [left, right].map((candidate) =>
      fs.realpath(candidate).catch(() => path.resolve(candidate)),
    ),
  );
  return realLeft === realRight;
}

async function readFileOrNull(target: string): Promise<string | null> {
  return fs.readFile(target, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
}

export interface SeedSanitizedCodexConfigTomlInput {
  /** The host Codex home the managed home is derived from (never written to). */
  sourceHome: string;
  /** The Paperclip-managed home. Must not be `sourceHome`. */
  targetHome: string;
  /** Receives a human-readable note when anything was dropped or is worth flagging. */
  onNote?: (note: string) => void | Promise<void>;
}

export interface SeedSanitizedCodexConfigTomlResult extends CodexSeedSanitizationReport {
  /** True when the managed `config.toml` was created or repaired on disk. */
  wrote: boolean;
}

/**
 * Seeds the managed home's `config.toml` from `sourceHome` with the host's
 * model/provider selection stripped, and re-checks (repairing in place) a home
 * that was already seeded.
 *
 * The re-check is the part that makes the fix durable. Copy-if-absent seeding
 * means every home created before this landed — and every home a hand-edit
 * repaired — keeps the dead pin until something deletes the file, and the next
 * re-seed is precisely what puts it back. When the managed config is already
 * clean (the steady state after one run) this is a read with no write, so it
 * does not churn the file.
 *
 * Callers must only pass a Paperclip-managed `targetHome` distinct from
 * `sourceHome`, so this never rewrites the user's own `~/.codex/config.toml`.
 */
export async function seedSanitizedCodexConfigToml(
  input: SeedSanitizedCodexConfigTomlInput,
): Promise<SeedSanitizedCodexConfigTomlResult> {
  const empty = { removedKeys: [], hasIndirectSelection: false, wrote: false };
  if (await isSameDirectory(input.sourceHome, input.targetHome)) return empty;

  const target = path.join(input.targetHome, CODEX_CONFIG_FILE);
  // A managed config.toml is always a regular file. Anything else at that path
  // (a directory, a symlink the user pointed somewhere) is not Paperclip-written
  // state, so leave it alone rather than reading through it or writing over it —
  // the same policy `ensureSymlink` applies to a directory in a managed home.
  const seeded = await fs.lstat(target).catch(() => null);
  if (seeded && !seeded.isFile()) return empty;

  const existing = seeded
    ? await readFileOrNull(target)
    : await readFileOrNull(path.join(input.sourceHome, CODEX_CONFIG_FILE));
  if (existing === null) return empty;
  const alreadySeeded = seeded !== null;

  const { content, removedKeys, hasIndirectSelection } =
    stripInheritedCodexModelSelection(existing);
  if (alreadySeeded && content === existing) {
    return { removedKeys, hasIndirectSelection, wrote: false };
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, { mode: 0o600 });
  // `mode` above only applies when writeFile creates the file. On the repair
  // path the managed config already exists — and a home seeded by the previous
  // copy-the-host-file behaviour inherited the host's mode, so it can well be
  // 0644. config.toml carries the managed MCP `Authorization: Bearer …` header,
  // so chmod explicitly rather than leaving those credentials world-readable.
  // This also pins the mode regardless of the process umask.
  await fs.chmod(target, 0o600);
  const note = describeCodexSeedSanitization({ removedKeys, hasIndirectSelection }, input);
  if (note && input.onNote) await input.onNote(note);
  return { removedKeys, hasIndirectSelection, wrote: true };
}

/**
 * Human-readable log line for a sanitization result, or null when the source
 * config carried nothing worth reporting.
 */
export function describeCodexSeedSanitization(
  report: CodexSeedSanitizationReport,
  input: { sourceHome: string; targetHome: string },
): string | null {
  const notes: string[] = [];
  if (report.removedKeys.length > 0) {
    const unique = [...new Set(report.removedKeys)].sort();
    notes.push(
      `[paperclip] Dropped host Codex model selection (${unique.join(", ")}) while seeding ` +
        `"${input.targetHome}" from "${input.sourceHome}"; Paperclip selects the model and ` +
        `provider for managed runs.`,
    );
  }
  if (report.hasIndirectSelection) {
    notes.push(
      `[paperclip] Managed Codex home "${input.targetHome}" inherited a root "profile" key from ` +
        `"${input.sourceHome}"; if that profile selects a model_provider, Codex runs will use it.`,
    );
  }
  return notes.length > 0 ? `${notes.join("\n")}\n` : null;
}
