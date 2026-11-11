import type { MatrixExecution } from "./types.js";
import { assertCursorCloudQualificationBudgetOptIn } from "./cursor-cloud-budget.js";
import { supportsKimiLocalProviderFault } from "./kimi-local-provider-fault.js";

/** Explicit-only profiles blocked until complete identity/auth/session/billing qualification. */
export const PENDING_PROFILE_PREREQUISITES = {
  "legacy-kimi-cli": "Kimi CLI identity/auth/skills/session/billing qualification is pending",
  "legacy-kimi-acp": "Kimi ACP identity/auth/skills/session/billing qualification is pending",
  "legacy-grok": "Grok identity/auth/skills/session/billing qualification is pending",
} as const;

/** Qualification fixtures use explicit models; there is no runtime model roster. */
export const UNQUALIFIED_PROFILE_GAPS = {
} as const;

/** Reject missing remote observer authority before creating a company or run. */
export function assertRemoteNativeEvidencePrerequisites(
  executions: readonly MatrixExecution[],
  environment: NodeJS.ProcessEnv,
): void {
  if (!executions.some(execution => execution.environment.id === "daytona"
    && ["cursor_native", "pi_native", "pi_controls", "copilot_protection", "native_active_stop", "native_provider_loss", "kimi_native_lifecycle"].includes(execution.task.flow))) return;
  const names = ["PAPERCLIP_E2E_DAYTONA_NODE_SHA256", "PAPERCLIP_E2E_DAYTONA_RUNNERD_SHA256"];
  const invalid = names.filter(name => !/^sha256:[a-f0-9]{64}$/u.test(environment[name] ?? ""));
  if (invalid.length) throw new Error(`Native Daytona evidence requires exact image executable digests: ${invalid.join(", ")}`);
}

type RunnerE2EHost = Pick<NodeJS.Process, "platform" | "arch">;

function isRunnerE2EHost(value: NodeJS.ProcessEnv | RunnerE2EHost): value is RunnerE2EHost {
  return Object.keys(value).length === 2 && typeof value.platform === "string" && typeof value.arch === "string";
}

export function assertRunnerE2EPrerequisites(
  executions: readonly MatrixExecution[],
  environmentOrHost: NodeJS.ProcessEnv | RunnerE2EHost = process.env,
  host: RunnerE2EHost = process,
): void {
  let environment: NodeJS.ProcessEnv;
  if (isRunnerE2EHost(environmentOrHost)) {
    host = environmentOrHost;
    environment = process.env;
  } else {
    environment = environmentOrHost;
  }
  if (executions.some(execution => execution.suite.id === "cursor-cloud" && execution.profile.provider === "cursor_cloud")) {
    assertCursorCloudQualificationBudgetOptIn(environment);
  }
  if (executions.some(execution => execution.profile.provider === "cursor_cloud")) {
    const required = ["PAPERCLIP_CURSOR_CLOUD_ACCEPTANCE_MODEL", "PAPERCLIP_CURSOR_CLOUD_ACCEPTANCE_REPO", "PAPERCLIP_PUBLIC_URL", "PAPERCLIP_CURSOR_CLOUD_CALLBACK_PORT"];
    const missing = required.filter(name => !environment[name]?.trim());
    if (missing.length) throw new Error(`Cursor Cloud acceptance setup-blocked: configure ${missing.join(", ")}. No provider credentials were loaded or sent.`);
    let repo: URL, origin: URL;
    try { repo = new URL(environment.PAPERCLIP_CURSOR_CLOUD_ACCEPTANCE_REPO!); origin = new URL(environment.PAPERCLIP_PUBLIC_URL!); }
    catch { throw new Error("Cursor Cloud acceptance setup-blocked: repository and public callback origin must be valid HTTPS URLs."); }
    const port = Number(environment.PAPERCLIP_CURSOR_CLOUD_CALLBACK_PORT);
    if (repo.protocol !== "https:" || repo.username || repo.password || repo.search || repo.hash
      || origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
      || !Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error("Cursor Cloud acceptance setup-blocked: use a credential-free HTTPS disposable repository, HTTPS callback origin, and dedicated loopback callback port (1024–65535).");
    }
    if (executions.some(execution => execution.profile.provider === "cursor_cloud" && (execution.environment.id !== "local" || execution.profile.model !== environment.PAPERCLIP_CURSOR_CLOUD_ACCEPTANCE_MODEL!.trim()))) {
      throw new Error("Cursor Cloud acceptance requires the exact configured model and a local controller.");
    }
  }
  if (!supportsKimiLocalProviderFault(host) && executions.some(execution =>
    execution.environment.id === "local" && execution.profile.qualificationCandidate === "kimi"
    && execution.task.id === "native-write-provider-loss")) {
    throw new Error(
      `Local native Kimi provider-loss qualification requires darwin-arm64; selected host is ${host.platform}-${host.arch}. `
      + "Use its qualified local host or the Linux Daytona cell. No provider credentials were loaded or sent, and no execution resources were acquired.",
    );
  }
  const blocked = [...new Set(
    executions
      .map((execution) => execution.profile.id)
      .filter((profileId): profileId is keyof typeof PENDING_PROFILE_PREREQUISITES =>
        profileId in PENDING_PROFILE_PREREQUISITES,
      ),
  )];
  if (blocked.length === 0) return;
  throw new Error(
    `Selected runner E2E profile prerequisite(s) are pending: ${blocked
      .map((profileId) => `${profileId} (${PENDING_PROFILE_PREREQUISITES[profileId]})`)
      .join("; ")}. No provider credentials were loaded or sent.`,
  );
}
