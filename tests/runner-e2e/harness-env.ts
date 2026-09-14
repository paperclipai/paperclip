import path from "node:path";
import { CREDENTIAL_NAMES } from "./types.js";
import type { MatrixExecution } from "./types.js";

const DATABASE_KEYS = ["DATABASE_URL", "DATABASE_MIGRATION_URL"] as const;
const AMBIENT_PAPERCLIP_CREDENTIAL_KEYS = [
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_AGENT_API_KEY",
  "PAPERCLIP_TASK_BRIDGE_TOKEN",
  "PAPERCLIP_SETUP_TOKEN",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
] as const;
const GENERATED_SERVER_SECRET_KEYS = [
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_DECISION_SIGNING_SECRET",
  "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
  "BETTER_AUTH_SECRET",
] as const;
const AMBIENT_EXTERNAL_STATE_KEYS = [
  "PAPERCLIP_STORAGE_S3_BUCKET",
  "PAPERCLIP_STORAGE_S3_REGION",
  "PAPERCLIP_STORAGE_S3_ENDPOINT",
  "PAPERCLIP_STORAGE_S3_PREFIX",
  "PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE",
] as const;
const PROVIDER_SECRET_KEY = /^(?:OPENAI|ANTHROPIC|OPENROUTER|DAYTONA)(?:_|$)/;

export function runnerE2EServerControlPaths(temporaryRoot: string) {
  const controlDirectory = path.join(temporaryRoot, "control");
  return {
    controlDirectory,
    restartRequestPath: path.join(
      controlDirectory,
      "server-restart.request.json",
    ),
    restartAcknowledgementPath: path.join(
      controlDirectory,
      "server-restart.ack.json",
    ),
  };
}

/**
 * Native cells use the debug binary produced once by build:runner-binaries.
 * Preserve an explicit override for release builds and developer workflows.
 */
export function resolvePaperclipRunnerBinaryForHarness(
  executions: readonly MatrixExecution[],
  repositoryRoot: string,
  configuredPath = process.env.PAPERCLIP_RUNNER_BINARY,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (configuredPath?.trim()) return configuredPath;
  if (
    !executions.some((execution) => execution.profile.generation === "native")
  ) {
    return undefined;
  }

  return path.join(
    repositoryRoot,
    "packages",
    "paperclip-runner",
    "runner",
    "target",
    "debug",
    platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd",
  );
}

/**
 * Remote native cells stage the same controller-owned binary whose digest is
 * authorized by the PRP control plane. Local cells launch it directly.
 */
export function resolvePaperclipRemoteRunnerBinaryForHarness(
  executions: readonly MatrixExecution[],
  runnerBinary: string | undefined,
  configuredPath = process.env.PAPERCLIP_RUNNER_REMOTE_BINARY_PATH,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (configuredPath?.trim()) return configuredPath;
  if (!runnerBinary) return undefined;
  // Daytona runs Linux. A default debug binary built by a macOS developer is
  // Mach-O and cannot be staged into that sandbox. Leave the remote override
  // unset so the pinned Daytona image's verified runnerd is discovered instead.
  if (platform !== "linux") return undefined;
  return executions.some(
    (execution) =>
      execution.profile.generation === "native" &&
      execution.environment.expectedExecutionTarget.kind === "remote",
  )
    ? runnerBinary
    : undefined;
}

/**
 * Keep fixture-only provider switches scoped to the one isolated harness that
 * needs them. In particular, the pinned legacy OpenCode model is routed by the
 * paid gateway and may not appear in OpenCode's public model catalog.
 */
export function buildRunnerE2EProcessEnvironment(
  source: NodeJS.ProcessEnv,
  executions: readonly MatrixExecution[],
): NodeJS.ProcessEnv {
  const result = { ...source };
  delete result.OPENCODE_ALLOW_ALL_MODELS;
  if (
    executions.length > 0 &&
    executions.every(
      (execution) =>
        execution.profile.generation === "legacy" &&
        execution.profile.provider === "opencode",
    )
  ) {
    result.OPENCODE_ALLOW_ALL_MODELS = "true";
  }
  return result;
}

/**
 * Build the environment inherited by the Paperclip server. Paid credentials
 * deliberately stay in the launcher/Playwright process and cross the server
 * boundary only once, in the encrypted company-secrets API request.
 */
export function buildPaperclipServerEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const result = { ...source };
  for (const key of Object.keys(result)) {
    if (PROVIDER_SECRET_KEY.test(key)) delete result[key];
  }
  for (const key of [
    ...CREDENTIAL_NAMES,
    ...DATABASE_KEYS,
    ...AMBIENT_PAPERCLIP_CREDENTIAL_KEYS,
    ...AMBIENT_EXTERNAL_STATE_KEYS,
  ]) {
    delete result[key];
  }
  for (const key of GENERATED_SERVER_SECRET_KEYS) delete result[key];
  Object.assign(result, overrides);
  return result;
}

export function assertIsolatedServerEnvironment(
  env: NodeJS.ProcessEnv,
  expected: {
    temporaryRoot: string;
    paperclipHome: string;
    configPath: string;
  },
) {
  const home = env.PAPERCLIP_HOME;
  const config = env.PAPERCLIP_CONFIG;
  if (home !== expected.paperclipHome || config !== expected.configPath) {
    throw new Error(
      "Paperclip server environment does not use the allocated home/config paths",
    );
  }
  if (
    !home.startsWith(`${expected.temporaryRoot}/`) ||
    !config.startsWith(`${expected.temporaryRoot}/`)
  ) {
    throw new Error(
      "Paperclip server paths escape the isolated temporary root",
    );
  }
  if (env.XDG_CACHE_HOME !== path.join(expected.temporaryRoot, "xdg-cache")) {
    throw new Error(
      "Paperclip server cache does not use the allocated temporary root",
    );
  }
  for (const key of [
    ...CREDENTIAL_NAMES,
    ...DATABASE_KEYS,
    ...AMBIENT_PAPERCLIP_CREDENTIAL_KEYS,
    ...AMBIENT_EXTERNAL_STATE_KEYS,
  ]) {
    if (env[key])
      throw new Error(
        `Paperclip server environment unexpectedly contains ${key}`,
      );
  }
  for (const key of GENERATED_SERVER_SECRET_KEYS) {
    if (!env[key])
      throw new Error(`Paperclip server environment is missing ${key}`);
  }
}
