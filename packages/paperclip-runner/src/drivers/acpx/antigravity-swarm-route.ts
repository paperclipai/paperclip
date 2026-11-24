import { userInfo } from "node:os";
import { join } from "node:path";
import { ANTIGRAVITY_CLI_DISTRIBUTION } from "./antigravity-cli-pins.js";
import { resolveAntigravityCliLaunch, type AntigravityCliLaunchOptions } from "./antigravity-cli-installation.js";
import { ANTIGRAVITY_CLI_STABLE_ENDPOINT, ANTIGRAVITY_SWARM_MODE, AntigravitySwarmError } from "./antigravity-swarm-guard.js";
import type { VerifiedAcpxInstallation } from "./installation-integrity.js";

/** The Antigravity CLI route is selected only by the trusted `swarm` provider mode. */
export function isAntigravitySwarmRoute(agent: string, mode: string | undefined): boolean {
  return agent === "antigravity" && mode === ANTIGRAVITY_SWARM_MODE;
}

/** Private CLI state (settings, skills, conversations) under the run's credential home. */
export function antigravitySwarmStateDirectory(agentHomeDirectory: string): string {
  return join(agentHomeDirectory, "antigravity-cli");
}

/** Driver-owned CLI flags: private state, stable endpoint, no telemetry. Self-update is off through the pinned environment. */
export function antigravitySwarmArguments(stateDirectory: string): string[] {
  return ["--gemini-dir", stateDirectory, "--cloud_code_endpoint", ANTIGRAVITY_CLI_STABLE_ENDPOINT, "--disable-telemetry"];
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
  options: Omit<AntigravityCliLaunchOptions, "arguments"> = {},
): Promise<VerifiedAcpxInstallation> {
  const pinned = await resolveAntigravityCliLaunch(options);
  return Object.freeze({
    commandDigest: pinned.commandDigest,
    agentServerPackageJsonPath: null,
    agentRuntimePackageJsonPath: null,
    async openCommand(open?: { signal?: AbortSignal }) {
      const launch = await resolveAntigravityCliLaunch({ ...options, arguments: antigravitySwarmArguments(stateDirectory()) });
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

/** Paperclip tools that create tasks, assign work or hire. A swarm is one run with one assignee. */
const DELEGATION_TOOL = /^paperclip_(?:create_(?:task|issue|subtask|agent)|hire|delegate|assign|reassign)/;

/** The bridge catalog for a swarm turn: the run's tools without delegation. */
export function antigravitySwarmTools<T extends Readonly<Record<string, unknown>>>(tools: readonly T[]): T[] {
  return tools.filter(tool => !(typeof tool.name === "string" && DELEGATION_TOOL.test(tool.name)));
}
