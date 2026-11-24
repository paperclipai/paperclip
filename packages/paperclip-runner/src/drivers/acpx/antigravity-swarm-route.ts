import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";
import { canonicalRunnerToolName } from "../runner-tool-bridge.js";
import { AntigravitySavedStateIncompatibleError } from "./antigravity-admission.js";
import { ANTIGRAVITY_CLI_DISTRIBUTION } from "./antigravity-cli-pins.js";
import { AntigravityCliRuntimeError, resolveAntigravityCliLaunch, type AntigravityCliLaunchOptions } from "./antigravity-cli-installation.js";
import { ANTIGRAVITY_CLI_STABLE_ENDPOINT, ANTIGRAVITY_SWARM_MODE, AntigravitySwarmError } from "./antigravity-swarm-guard.js";
import {
  GENERATED_ANTIGRAVITY_SWARM_CREDENTIAL_FACTS_FIELD, GENERATED_ANTIGRAVITY_SWARM_DEFAULT_CHANNEL, readGeneratedAntigravitySwarmCredentialFacts,
  type GeneratedAntigravitySwarmChannel,
} from "./generated-sidecar-contract.js";
import type { VerifiedAcpxInstallation } from "./installation-integrity.js";

/** The Antigravity CLI route is selected only by the trusted `swarm` provider mode. */
export function isAntigravitySwarmRoute(agent: string, mode: string | undefined): boolean {
  return agent === "antigravity" && mode === ANTIGRAVITY_SWARM_MODE;
}

const HAND_IN_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * A swarm's only prompt is the user's request, so the hand-in values that the
 * first message's `completionContract` gives an ordinary turn reach the
 * coordinator through Paperclip's own instructions instead. Only the
 * server-written contract revision and criterion IDs are rendered, never a
 * criterion's requirement (which quotes task and comment text), and a value
 * outside the closed identifier shape is never rendered at all.
 */
export function antigravitySwarmHandInInstructions(contract: { revision: string; criteria: readonly { id: string }[] }): string | null {
  const criterionIds = contract.criteria.map(criterion => criterion.id);
  if (!HAND_IN_VALUE.test(contract.revision) || !criterionIds.every(id => HAND_IN_VALUE.test(id))) return null;
  return [
    "## Paperclip hand-in",
    `When you call paperclip_finish or paperclip_block, set completionClaim.contractRevision to ${JSON.stringify(contract.revision)} and list each of these criterion IDs exactly once in completionClaim.criteria: ${JSON.stringify(criterionIds)}.`,
  ].join("\n");
}

/** Private CLI state (settings, skills, conversations) under the run's credential home. */
export function antigravitySwarmStateDirectory(agentHomeDirectory: string): string {
  return join(agentHomeDirectory, "antigravity-cli");
}

/**
 * Which Google channel the CLI talks to. `provider_default` passes no endpoint,
 * so the pinned CLI uses its own default (Google's daily channel, the one
 * Google's own app and CLI use, which can change with less notice); `stable`
 * pins Google's stable endpoint (which, on 2026-11-24, offered no Gemini 4 Neon).
 * The deployment chooses it (server env PAPERCLIP_ANTIGRAVITY_SWARM_CHANNEL).
 */
export type AntigravitySwarmChannel = GeneratedAntigravitySwarmChannel;

/** Plain words for the channel, for the swarm's start step and diagnostics. */
export function antigravitySwarmChannelLabel(channel: AntigravitySwarmChannel): string {
  return channel === "stable" ? "Google's stable channel" : "Google's default channel";
}

/** The CLI's own log inside its private state; it records which Google account the CLI signed in with. */
export function antigravitySwarmLogFile(stateDirectory: string): string {
  return join(stateDirectory, "cli.log");
}

/** Driver-owned CLI flags: private state and log, the channel, no telemetry. Self-update is off through the pinned environment. */
export function antigravitySwarmArguments(stateDirectory: string, channel: AntigravitySwarmChannel = GENERATED_ANTIGRAVITY_SWARM_DEFAULT_CHANNEL): string[] {
  return ["--gemini-dir", stateDirectory, "--log-file", antigravitySwarmLogFile(stateDirectory),
    ...(channel === "stable" ? ["--cloud_code_endpoint", ANTIGRAVITY_CLI_STABLE_ENDPOINT] : []), "--disable-telemetry"];
}

/** A one-way, non-identifying form of a Google account for comparing the CLI's sign-in with the connection. */
export function antigravityAccountDigest(email: string): string {
  return createHash("sha256").update(`paperclip.antigravity-account.v1:${email.trim().toLowerCase()}`, "utf8").digest("hex");
}

/**
 * Run facts the controller binds to the selected Google credential (the
 * `paperclip` member of the credential document; the credential sanitizer drops
 * it before anything is written): the swarm channel and the connection
 * account's digest. Absent or malformed facts fall back to the provider default
 * channel and an unknown account.
 */
export function antigravitySwarmBinding(environment: NodeJS.ProcessEnv): { channel: AntigravitySwarmChannel; accountDigest: string | null } {
  let facts: ReturnType<typeof readGeneratedAntigravitySwarmCredentialFacts> = null;
  try {
    const parsed = JSON.parse(environment.PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET ?? "{}") as Record<string, unknown> | null;
    facts = readGeneratedAntigravitySwarmCredentialFacts(parsed?.[GENERATED_ANTIGRAVITY_SWARM_CREDENTIAL_FACTS_FIELD]);
  } catch { /* the route refusal reports a missing credential */ }
  return { channel: facts?.swarmChannel ?? GENERATED_ANTIGRAVITY_SWARM_DEFAULT_CHANNEL, accountDigest: facts?.accountSha256 ?? null };
}

/**
 * Plain-language refusal when this host or connection cannot run a swarm.
 * Helpers write only in the CLI's auto mode, which API-key connections lack.
 */
export function antigravitySwarmRouteRefusal(input: { environment: NodeJS.ProcessEnv; platform?: string; architecture?: string }): AntigravitySwarmError | null {
  const target = `${input.platform ?? process.platform}-${input.architecture ?? process.arch}`;
  if (!Object.hasOwn(ANTIGRAVITY_CLI_DISTRIBUTION.platforms, target)) {
    return new AntigravitySwarmError("ANTIGRAVITY_SWARM_UNAVAILABLE", `Swarm is not available on this computer: the Antigravity CLI has no pinned build for ${target}.`);
  }
  if (!input.environment.PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET) {
    return new AntigravitySwarmError("ANTIGRAVITY_SWARM_UNAVAILABLE",
      "Swarm is not available with a Gemini API key: helpers can only change files in Antigravity's auto mode, which needs a Google sign-in.");
  }
  return null;
}

/**
 * The pinned CLI as an ACPX installation. Its per-run `--gemini-dir` is known only
 * after the sandbox exists, so the launch arguments are bound when the command opens.
 */
export async function verifyAntigravitySwarmInstallation(
  stateDirectory: () => string,
  options: Omit<AntigravityCliLaunchOptions, "arguments"> & { channel?: AntigravitySwarmChannel } = {},
): Promise<VerifiedAcpxInstallation> {
  const { channel, ...launchOptions } = options;
  const pinned = await resolveAntigravityCliLaunch(launchOptions).catch((error: unknown) => {
    // The runtime-missing and unsupported-platform messages are written for people; keep them visible.
    if (error instanceof AntigravityCliRuntimeError) throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_UNAVAILABLE", `Swarm is not available on this computer: ${error.message}`);
    throw error;
  });
  return Object.freeze({
    commandDigest: pinned.commandDigest,
    agentServerPackageJsonPath: null,
    agentRuntimePackageJsonPath: null,
    async openCommand(open?: { signal?: AbortSignal }) {
      const launch = await resolveAntigravityCliLaunch({ ...launchOptions, arguments: antigravitySwarmArguments(stateDirectory(), channel) });
      if (launch.commandDigest !== pinned.commandDigest) throw new Error("Antigravity CLI installation changed during admission");
      return launch.installation.openCommand(open);
    },
  });
}

/**
 * Launch environment for the CLI: the sandbox's private environment without the
 * registry server's credential plumbing. On macOS the CLI keeps its Google
 * sign-in in the login keychain, which it finds through the real HOME, so HOME is
 * the OS user's home there; all CLI state still lives in the private `--gemini-dir`.
 */
export function antigravitySwarmLaunchEnvironment(
  sandbox: Readonly<NodeJS.ProcessEnv>,
  input: { agentHomeDirectory: string; platform?: NodeJS.Platform; realHome?: string },
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...sandbox };
  for (const name of ["GEMINI_HOME", "AGY_ACP_FORCE_FILE_STORAGE", "GEMINI_API_KEY", "GOOGLE_API_KEY", "PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET"]) delete environment[name];
  if ((input.platform ?? process.platform) === "darwin") environment.HOME = input.realHome ?? userInfo().homedir;
  return { ...environment, ...ANTIGRAVITY_CLI_DISTRIBUTION.environment };
}

/**
 * Paperclip operations that create, assign or hand off work, hire, or reach the
 * generic API (which can do any of those). A swarm is one run with one
 * assignee, so none of them is offered on a swarm turn. Production catalogs
 * name tools by bare operation id; prefixed names are matched canonically.
 */
export const ANTIGRAVITY_SWARM_DELEGATING_OPERATIONS: ReadonlySet<string> = new Set([
  "create_task", "create_issue", "create_subtask", "reassign_task", "assign_task", "set_dependencies", "delegate_task",
  "hire_agent", "create_agent", "call_api",
  "create_project", "create_case", "update_case", "handoff_case", "create_workflow", "update_workflow",
  "update_routine", "create_routine", "create_area", "update_area", "create_responsibility", "update_responsibility",
]);

/** The bridge catalog for a swarm turn: the run's tools without delegation. */
export function antigravitySwarmTools<T extends Readonly<Record<string, unknown>>>(tools: readonly T[]): T[] {
  return tools.filter(tool => ![tool.name, tool.operationId].some(name =>
    typeof name === "string" && ANTIGRAVITY_SWARM_DELEGATING_OPERATIONS.has(canonicalRunnerToolName(name))));
}

/**
 * A saved conversation from the other Antigravity route (swarm on the CLI, or
 * an ordinary turn on the registry server) cannot be reopened by this one. The
 * typed refusal makes the server start a fresh conversation, so the task keeps
 * accepting messages after a swarm and a later /swarm starts cleanly.
 */
export function antigravityRouteChangeRefusal(agent: string, savedMode: string | undefined, requestedMode: string | undefined): AntigravitySavedStateIncompatibleError | null {
  if (agent !== "antigravity") return null;
  if (isAntigravitySwarmRoute(agent, savedMode) === isAntigravitySwarmRoute(agent, requestedMode)) return null;
  return new AntigravitySavedStateIncompatibleError("the saved conversation belongs to a different Antigravity route");
}
