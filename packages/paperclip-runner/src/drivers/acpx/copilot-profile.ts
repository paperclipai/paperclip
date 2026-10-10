import { isAbsolute, resolve } from "node:path";

/** This is an admission candidate, not a claim of live qualification. */
export const COPILOT_VERSION = "1.0.88" as const;
export const COPILOT_SYSTEM_INSTRUCTIONS_FILE = "copilot-instructions.md" as const;
export const COPILOT_SYSTEM_INSTRUCTION_DELIVERY = "COPILOT_HOME/copilot-instructions.md:replace-under-lifetime-lease-before-launch:v1" as const;
export const COPILOT_CREDENTIAL_ENVIRONMENT_NAME = "COPILOT_GITHUB_TOKEN" as const;

// Keep permission callbacks enabled even when Paperclip's policy is approve-all.
// In particular COPILOT_ALLOW_ALL=true also trusts workspace hooks/plugins/MCP.
export const COPILOT_LAUNCH_ARGUMENTS = Object.freeze([
  "--acp", "--stdio", "--no-auto-update", "--disable-builtin-mcps",
  "--no-remote", "--no-remote-export", "--no-bash-env",
  "--secret-env-vars=COPILOT_GITHUB_TOKEN",
]);

export interface CopilotSandboxDirectories {
  homeDirectory: string;
  configDirectory: string;
  dataDirectory: string;
  cacheDirectory: string;
  agentHomeDirectory: string;
}

/** Add only sandbox-owned values after the common credential allowlist. */
export function copilotSandboxEnvironment(directories: CopilotSandboxDirectories): Readonly<NodeJS.ProcessEnv> {
  for (const directory of Object.values(directories)) {
    if (!isAbsolute(directory) || resolve(directory) !== directory || directory.includes("\0")) {
      throw new Error("Copilot sandbox directories must be normalized absolute paths");
    }
  }
  return Object.freeze({
    HOME: directories.homeDirectory,
    XDG_CONFIG_HOME: directories.configDirectory,
    XDG_DATA_HOME: directories.dataDirectory,
    XDG_CACHE_HOME: directories.cacheDirectory,
    COPILOT_HOME: directories.agentHomeDirectory,
    COPILOT_CACHE_HOME: directories.cacheDirectory,
    COPILOT_PKG_CACHE_HOME: directories.cacheDirectory,
    COPILOT_AUTO_UPDATE: "false",
    COPILOT_ALLOW_ALL: "false",
    COPILOT_DISABLE_TERMINAL_TITLE: "true",
    NO_COLOR: "1",
  });
}

/** Written by the shared sandbox's private atomic writer before every admission. */
export function copilotConfiguration(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    autoUpdate: false,
    trustedFolders: [],
    disableAllHooks: true,
    memory: false,
    ide: { autoConnect: false, openDiffOnEdit: false },
  });
}

export type CopilotFailureCode =
  | "COPILOT_AUTH_REQUIRED"
  | "COPILOT_ENTITLEMENT_DENIED"
  | "COPILOT_MODEL_UNAVAILABLE"
  | "COPILOT_REQUEST_FAILED";

/** The runner binds this credential explicitly; ambient gh login is never used. */
export function assertCopilotCredentials(environment: Readonly<NodeJS.ProcessEnv>): void {
  const token = environment.COPILOT_GITHUB_TOKEN;
  if (typeof token !== "string" || token.trim().length === 0 || token.includes("\0")) {
    throw Object.assign(new Error("Bind a valid COPILOT_GITHUB_TOKEN credential for this runner."), {
      code: "COPILOT_AUTH_REQUIRED", retryable: false,
    });
  }
}

/** Classify, but never echo provider text that may contain tokens or user data. */
export function classifyCopilotFailure(error: unknown): { code: CopilotFailureCode; message: string } {
  const source = error instanceof Error ? error.message
    : typeof error === "string" ? error
    : isRecord(error) && typeof error.message === "string" ? error.message : "";
  const message = source.slice(0, 8192).toLowerCase();
  if (/authentication required|unauthorized|invalid (?:github )?token|not (?:logged|signed) in|copilot_github_token.*(?:missing|required|not configured)|(?:missing|no) (?:copilot |github )?(?:credential|token|authentication)/.test(message)) {
    return { code: "COPILOT_AUTH_REQUIRED", message: "Bind a valid COPILOT_GITHUB_TOKEN credential for this runner." };
  }
  if (/entitlement|subscription|organization policy|organisation policy|policy.*(?:denied|disabled)|access denied|forbidden|not entitled/.test(message)) {
    return { code: "COPILOT_ENTITLEMENT_DENIED", message: "Copilot access is denied by the account entitlement or organization policy." };
  }
  if (/(?:model.*(?:not found|unavailable|not available|not supported|unsupported|invalid)|unknown model|invalid model)/.test(message)) {
    return { code: "COPILOT_MODEL_UNAVAILABLE", message: "The explicitly selected Copilot model is unavailable for this account." };
  }
  return { code: "COPILOT_REQUEST_FAILED", message: "The Copilot ACP request failed." };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
