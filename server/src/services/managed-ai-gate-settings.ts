import { constants as fsConstants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError } from "../errors.js";


export const MANAGED_AI_GATE_SETTINGS_FILE = "settings.json";

export type ManagedAiGateFailureReason =
  | "host_settings_unreadable"
  | "gate_not_carried"
  | "hook_command_unreachable"
  | "hook_command_not_portable";

export const MANAGED_AI_GATE_UNREACHABLE_CODE = "managed_ai_gate_unreachable";

export class ManagedAiGateUnreachableError extends HttpError {
  readonly reason: ManagedAiGateFailureReason;
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
  settings: Record<string, unknown>;
  hookCommands: string[];
  denyRules: string[];
}

export interface ManagedAiGateSeedResult {
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

export function resolveHostClaudeSettingsDir(processEnv: NodeJS.ProcessEnv): string {
  const inherited = nonEmpty(processEnv.CLAUDE_CONFIG_DIR);
  if (inherited) return path.resolve(inherited);
  return path.join(os.homedir(), ".claude");
}

export function runReadsClaudeUserSettings(adapterType: string): boolean {
  return adapterType === "claude_local";
}

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

export function selectManagedAiGateSettings(hostSettings: unknown): ManagedAiGateSelection {
  const host = asObject(hostSettings);
  const settings: Record<string, unknown> = {};
  if (!host) return { settings, hookCommands: [], denyRules: [] };

  const hooks = asObject(host.hooks);
  const hookCommands = collectHookCommands(hooks);
  if (hooks && Object.keys(hooks).length > 0) settings.hooks = hooks;

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

export function hostOnlyHookCommandPaths(hookCommands: readonly string[]): string[] {
  return hookCommands
    .map((command) => hookCommandLocalPath(command))
    .filter((localPath): localPath is string => localPath !== null);
}

export function managedAiGateNotPortableMessage(
  hostOnlyPaths: readonly string[],
  environmentName?: string | null,
): string {
  const where = environmentName
    ? `the remote environment ${environmentName}`
    : "a remote environment";
  return `The runner gate hook ${hostOnlyPaths.join(", ")} is a path on the Paperclip server, and this run executes in ${where}, which cannot see it, so the gate would not run. Install the hook in that environment, or run this agent on the server host.`;
}

export function assertManagedAiGateReachesRemoteTarget(input: {
  hookCommands: readonly string[];
  environmentName?: string | null;
}): void {
  const hostOnly = hostOnlyHookCommandPaths(input.hookCommands);
  if (hostOnly.length === 0) return;
  throw new ManagedAiGateUnreachableError(
    "hook_command_not_portable",
    managedAiGateNotPortableMessage(hostOnly, input.environmentName),
    hostOnly,
  );
}
