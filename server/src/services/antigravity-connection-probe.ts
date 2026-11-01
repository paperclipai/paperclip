import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { NativeEnvironmentProbeCleanupError, probeNativeRunnerEnvironment, resolveAcpxRuntimeRoot } from "../vendor/paperclip-runner/index.js";
import { logger } from "../middleware/logger.js";
import { resolveAntigravityCandidateAdmission } from "./native-runtime/acpx-qualification.js";
import { antigravityCredentialTurn, prepareAntigravityRunnerCredentials } from "./native-runtime/antigravity-runner-credentials.js";
import { resolvePaperclipRunnerBinary } from "./native-runtime/native-codex-runner.js";

const TRANSPORT_KEYS = ["PATH", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TEMP", "TMP", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"];

const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Project only closed Rust admission categories from the private authenticated
 * command result. Provider output and the outer serialized Error stay private.
 */
export function antigravityConnectionProbeFailure(companyId: string, error: unknown): AdapterEnvironmentTestResult {
  if (error instanceof NativeEnvironmentProbeCleanupError) throw error;
  const command = asRecord(asRecord(error)?.runnerCommandResult);
  const result = command?.commandType === "session.open" && command.status === "failed" ? asRecord(command.result) : null;
  const admission = result?.code === "command_execution_failed" && typeof result.message === "string" && result.message.length <= 2_048
    ? /^failed to start ACPX provider: ACPX sidecar command (?:initialize|session\.open) was rejected \(retryable=(true|false), classification=(admission_(?:binding|installation|sandbox|credential|configuration|skills|command|tool_bridge|runtime|identity))\)$/.exec(result.message)
    : null;
  const installation = admission?.[2] === "admission_installation";
  const code = installation ? "antigravity_installation_check_failed" : "antigravity_admission_failed";
  const errorClass = error instanceof Error && ["Error", "TypeError", "RangeError", "AggregateError"].includes(error.name) ? error.name : "Error";
  logger.warn({ companyId, code, errorClass,
    commandCode: admission ? "command_execution_failed" : "unclassified",
    classification: admission?.[2] ?? "unclassified",
    ...(admission ? { retryable: admission[1] === "true" } : {}),
  }, installation ? "Antigravity installation check failed before account verification" : "Antigravity runtime admission check failed");
  return { adapterType: "paperclip_runner", status: "fail", testedAt: new Date().toISOString(), checks: [{ code, level: "error",
    message: installation ? "Paperclip could not complete the local Google Antigravity installation check."
      : "Google Antigravity could not complete its runtime check.",
    hint: installation ? "The instance operator needs to repair this runtime before Test can verify your Google connection."
      : "Retry Test. If it still fails, ask your Paperclip operator to inspect the runtime check.",
  }] };
}

/** The ordinary Test uses the selected managed account and no model turn. */
export async function testAntigravityConnection(context: AdapterEnvironmentTestContext, model: string): Promise<AdapterEnvironmentTestResult> {
  if (context.executionTarget?.kind === "remote") throw new Error("Google Antigravity candidate testing requires the Paperclip host.");
  const admission = resolveAntigravityCandidateAdmission({ companyId: context.companyId, model });
  if (!admission) throw new Error("Google Antigravity is not available for this company.");
  const configured = context.config.env;
  const environment = Object.fromEntries([
    ...TRANSPORT_KEYS.flatMap(key => typeof process.env[key] === "string" ? [[key, process.env[key]!]] : []),
    ...Object.entries(configured && typeof configured === "object" && !Array.isArray(configured) ? configured : {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  ]);
  const credentials = await prepareAntigravityRunnerCredentials({ environment, remote: false,
    managedHome: context.managedAiCredentialHome, lifecycleMode: "per_turn" });
  const runtimeDirectory = await realpath(await mkdtemp(join(tmpdir(), "paperclip-antigravity-setup-")));
  const acpxRuntimeDirectory = join(runtimeDirectory, "acpx");
  const nonce = randomUUID(), normalizedSessionId = `setup-${nonce}`;
  let nativeHome: string, runnerBinary: string;
  try {
    await mkdir(acpxRuntimeDirectory, { mode: 0o700 });
    nativeHome = join(await resolveAcpxRuntimeRoot(acpxRuntimeDirectory, normalizedSessionId), "antigravity-home");
    runnerBinary = resolvePaperclipRunnerBinary();
  } catch (error) {
    await rm(runtimeDirectory, { recursive: true, force: true });
    throw error;
  }
  const turn = credentials.home && credentials.credential
    ? antigravityCredentialTurn({ managedHome: credentials.home, runtimeHome: nativeHome, credential: credentials.credential }) : undefined;
  const receipt = await probeNativeRunnerEnvironment({ runtimeDirectory, provider: "acpx", model,
    environment: credentials.environment, admissionOnly: true, timeoutMs: 45_000,
    transportOptions: { runnerBinary, externallySandboxed: false,
      acpxAgent: "antigravity", acpxCandidateAdmission: admission, acpxRuntimeDirectory,
      acpxPermissionMode: "approve-reads", acpxPermissionModePinned: true,
      prpIdentity: { runnerInstanceId: `setup-runner-${nonce}`, runId: `setup-${nonce}`, normalizedSessionId,
        environmentLeaseId: `setup-lease-${nonce}`, turnId: `setup-turn-${nonce}`, itemId: `setup-item-${nonce}` } },
    onCleanupConfirmed: async () => {
      // The native owner proves physical retirement before this callback.
      await turn?.copyBack();
      await turn?.remove();
      await rm(runtimeDirectory, { recursive: true, force: true });
    },
  });
  if (receipt.provider !== "acpx" || receipt.providerDriver !== "acpx_runtime" || receipt.effectiveModel !== model
    || receipt.sessionAdmissionPassed !== true || receipt.admissionOnly !== true || receipt.helloProbePassed !== false) {
    throw new Error("The selected Google runtime returned no matching account and model admission receipt.");
  }
  return { adapterType: "paperclip_runner", status: "pass", testedAt: new Date().toISOString(),
    checks: [{ code: "antigravity_metadata_verified", level: "info",
      message: "The Google Antigravity candidate verified the selected account and exact model. No model prompt was sent." }] };
}
