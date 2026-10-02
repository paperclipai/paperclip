import { constants as fsConstants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError } from "../errors.js";

/**
 * A run on a managed AI connection gets a private, per-run Claude config
 * directory (`CLAUDE_CONFIG_DIR=<managed home>/provider`) so the run cannot
 * reach the operator's stored provider login and so the spend lands on the
 * selected connection. That isolation is deliberate, but it also drops the
 * operator's *user* settings source — and on a managed runner host that source
 * is the only place the deny-side runner gates are registered: the
 * `PreToolUse` hooks (the merge gate, the secret guard, the sign guard) and the
 * `permissions.deny` list. Before this module, every managed-connection run
 * started with an empty config dir, so those gates silently did not run.
 *
 * So: carry the deny-side keys of the host user settings into the managed
 * config dir, and nothing else. The allowlist is the point. Copying the whole
 * host settings file would hand the run the host's `env`/`apiKeyHelper` (which
 * can re-inject a provider credential and defeat the isolation) and the host's
 * `permissions.defaultMode` (which can widen the run's posture). `hooks` and
 * `permissions.deny` can only ever refuse more work than the run would
 * otherwise be allowed, so they are safe to inherit and unsafe to lose.
 *
 * Then assert it. A gate that fails to arrive must fail the run, because a
 * security boundary that is absent should not be silently absent.
 */

/** The user-settings file name every Claude runner reads from its config dir. */
export const MANAGED_AI_GATE_SETTINGS_FILE = "settings.json";

export type ManagedAiGateFailureReason =
  /** The host settings file exists but cannot be read or parsed, so any gate it declares is invisible to us. */
  | "host_settings_unreadable"
  /** The gate was selected but is not present in the file the run will read. */
  | "gate_not_carried"
  /** A carried hook names a local script that the run cannot execute. */
  | "hook_command_unreachable";

export const MANAGED_AI_GATE_UNREACHABLE_CODE = "managed_ai_gate_unreachable";

export class ManagedAiGateUnreachableError extends HttpError {
  readonly reason: ManagedAiGateFailureReason;
  /** The specific paths or keys that failed, for the run failure message. */
  readonly detail: string[];

  constructor(reason: ManagedAiGateFailureReason, message: string, detail: string[] = []) {
    super(422, message, { code: MANAGED_AI_GATE_UNREACHABLE_CODE, reason, detail });
    this.name = "ManagedAiGateUnreachableError";
    this.reason = reason;
    this.detail = detail;
  }
}

export function isManagedAiGateUnreachableError(
  error: unknown,
): error is ManagedAiGateUnreachableError {
  return error instanceof ManagedAiGateUnreachableError;
}

export interface ManagedAiGateSelection {
  /** The allowlisted subset of the host user settings; empty when no gate is declared. */
  settings: Record<string, unknown>;
  /** Every `type: "command"` hook command the selection carries. */
  hookCommands: string[];
  /** Every `permissions.deny` rule the selection carries. */
  denyRules: string[];
}

export interface ManagedAiGateSeedResult {
  /** The file written into the managed config dir, or null when there was no gate to carry. */
  settingsPath: string | null;
  hookCommands: string[];
  denyRules: string[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The settings source the run would have read if the managed home had not
 * repointed `CLAUDE_CONFIG_DIR`: the adapter-configured directory first (the
 * operator named it for this agent), then the directory the server process
 * itself runs with, then the Claude default.
 */
export function resolveHostClaudeSettingsDir(
  processEnv: NodeJS.ProcessEnv,
  configuredEnv?: Record<string, unknown> | null,
): string {
  const configured = nonEmpty(configuredEnv?.CLAUDE_CONFIG_DIR);
  if (configured) return path.resolve(configured);
  const inherited = nonEmpty(processEnv.CLAUDE_CONFIG_DIR);
  if (inherited) return path.resolve(inherited);
  return path.join(os.homedir(), ".claude");
}

/**
 * True when the run's runner reads a Claude user settings source, and so when
 * the host's Claude gate applies to it. Mirrors the adapter resolution in
 * `isAiConnectionCompatible`: a `paperclip_runner` agent is a Claude runner
 * only through its configured provider.
 */
export function runReadsClaudeUserSettings(
  adapterType: string,
  config: Record<string, unknown>,
): boolean {
  if (adapterType === "claude_local") return true;
  if (adapterType !== "paperclip_runner") return false;
  return (
    config.provider === "claude" ||
    (config.provider === "acpx" && config.acpxAgent === "claude")
  );
}

/** Every `type: "command"` hook command in a Claude `hooks` block, in declaration order. */
export function collectHookCommands(hooks: unknown): string[] {
  const block = asObject(hooks);
  if (!block) return [];
  const commands: string[] = [];
  for (const matcherGroups of Object.values(block)) {
    if (!Array.isArray(matcherGroups)) continue;
    for (const matcherGroup of matcherGroups) {
      const group = asObject(matcherGroup);
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const entry of group.hooks) {
        const hook = asObject(entry);
        if (!hook) continue;
        if (hook.type !== undefined && hook.type !== "command") continue;
        const command = nonEmpty(hook.command);
        if (command) commands.push(command);
      }
    }
  }
  return commands;
}

/**
 * The single local file a hook command runs, when the command is exactly that.
 * A command resolved through `PATH` (`rtk hook claude`), through a variable
 * (`$CLAUDE_PROJECT_DIR/...`) or written as a shell snippet has no one file to
 * check, so it returns null and the runner keeps ownership of resolving it.
 */
export function hookCommandLocalPath(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const quote = trimmed[0];
  let token: string;
  if (quote === "'" || quote === '"') {
    const end = trimmed.indexOf(quote, 1);
    if (end < 0) return null;
    token = trimmed.slice(1, end);
  } else {
    token = trimmed.split(/\s+/, 1)[0] ?? "";
  }
  return token.startsWith("/") ? token : null;
}

/** The deny-side allowlist of the host user settings. See the module comment. */
export function selectManagedAiGateSettings(hostSettings: unknown): ManagedAiGateSelection {
  const host = asObject(hostSettings);
  const settings: Record<string, unknown> = {};
  if (!host) return { settings, hookCommands: [], denyRules: [] };

  const hooks = asObject(host.hooks);
  const hookCommands = collectHookCommands(hooks);
  if (hooks && hookCommands.length > 0) settings.hooks = hooks;

  const denyRules = (asObject(host.permissions)?.deny ?? []) as unknown;
  const deny = Array.isArray(denyRules)
    ? denyRules.filter((rule): rule is string => typeof rule === "string" && rule.length > 0)
    : [];
  if (deny.length > 0) settings.permissions = { deny };

  return { settings, hookCommands, denyRules: deny };
}

async function readHostSettings(hostSettingsDir: string): Promise<unknown | undefined> {
  const settingsPath = path.join(hostSettingsDir, MANAGED_AI_GATE_SETTINGS_FILE);
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    // No host user settings at all means no gate is configured on this host,
    // which is the ordinary case for a plain install. Anything else — a
    // permission error, an I/O error — could be hiding a gate, so it fails.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ManagedAiGateUnreachableError(
      "host_settings_unreadable",
      `Could not read the runner gate settings at ${settingsPath}; refusing to start a managed AI run without the gate it declares.`,
      [settingsPath],
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ManagedAiGateUnreachableError(
      "host_settings_unreadable",
      `Could not parse the runner gate settings at ${settingsPath}; refusing to start a managed AI run without the gate it declares.`,
      [settingsPath],
    );
  }
}

/**
 * Carry the host's deny-side gate into a managed AI run's private Claude
 * config directory, then assert the run can actually reach it.
 *
 * Throws {@link ManagedAiGateUnreachableError} when a declared gate cannot be
 * carried or cannot be executed. Returns what was carried, with a null
 * `settingsPath` when the host declares no gate.
 */
export async function seedManagedAiGateSettings(input: {
  providerHome: string;
  hostSettingsDir: string;
}): Promise<ManagedAiGateSeedResult> {
  const hostSettings = await readHostSettings(input.hostSettingsDir);
  if (hostSettings === undefined) return { settingsPath: null, hookCommands: [], denyRules: [] };

  const selection = selectManagedAiGateSettings(hostSettings);
  if (Object.keys(selection.settings).length === 0) {
    return { settingsPath: null, hookCommands: [], denyRules: [] };
  }

  const settingsPath = path.join(input.providerHome, MANAGED_AI_GATE_SETTINGS_FILE);
  await writeFile(settingsPath, `${JSON.stringify(selection.settings, null, 2)}\n`, {
    mode: 0o600,
  });

  // Read back the file the run will actually load. A write that landed
  // somewhere else, or landed truncated, must not pass for a live gate.
  const carried = await readHostSettings(input.providerHome);
  if (JSON.stringify(carried) !== JSON.stringify(selection.settings)) {
    throw new ManagedAiGateUnreachableError(
      "gate_not_carried",
      `The runner gate declared in ${input.hostSettingsDir} did not survive into the managed Claude config dir ${input.providerHome}.`,
      Object.keys(selection.settings),
    );
  }

  const unreachable: string[] = [];
  for (const command of selection.hookCommands) {
    const localPath = hookCommandLocalPath(command);
    if (!localPath) continue;
    const reachable = await access(localPath, fsConstants.X_OK).then(
      () => true,
      () => false,
    );
    if (!reachable) unreachable.push(localPath);
  }
  if (unreachable.length > 0) {
    throw new ManagedAiGateUnreachableError(
      "hook_command_unreachable",
      `The runner gate hook ${unreachable.join(", ")} is not an executable file, so the gate would not run in this managed AI run.`,
      unreachable,
    );
  }

  return {
    settingsPath,
    hookCommands: selection.hookCommands,
    denyRules: selection.denyRules,
  };
}
