import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { NativeEnvironmentProbeCleanupError, QUALIFIED_ACPX_PROFILES, probeNativeRunnerEnvironment, resolveAcpxRuntimeRoot } from "../vendor/paperclip-runner/index.js";
import { logger } from "../middleware/logger.js";
import { antigravityRemoteCandidateAdmitted, resolveAntigravityCandidateAdmission } from "./native-runtime/acpx-qualification.js";
import { antigravityCredentialTurn, prepareAntigravityRunnerCredentials } from "./native-runtime/antigravity-runner-credentials.js";
import { antigravityConnectionRefusal } from "./native-runtime/antigravity-connection-policy.js";
import { antigravityReleasePending } from "./native-runtime/antigravity-release.js";
import { ANTIGRAVITY_PATCHED_CLOSURE_SHA256, antigravityProviderPackEntryRefusal } from "./native-runtime/remote-provider-pack.js";
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
    ? /^failed to start ACPX provider: ACPX sidecar command (?:initialize|session\.open) was rejected \(retryable=(true|false), classification=(admission_(?:binding|installation|sandbox|credential|configuration|skills|command|tool_bridge|runtime|identity|instructions))\)$/.exec(result.message)
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

const failed = (code: string, message: string): AdapterEnvironmentTestResult => ({ adapterType: "paperclip_runner", status: "fail",
  testedAt: new Date().toISOString(), checks: [{ code, level: "error", message }] });

const REMOTE_PACK_ROOTS = ["/opt/paperclip-runner/provider-pack", '"$HOME/.local/share/paperclip-runner/provider-pack"'];

/**
 * A cloud environment runs Antigravity from its image's provider pack. Test
 * proves that pack carries this release's patched Linux closure, exactly as run
 * preparation admits it, without reading credentials there or sending a prompt.
 * The run itself verifies the closure tree before launch.
 */
export async function probeAntigravityExecutionTarget(target: Extract<AdapterExecutionTarget, { kind: "remote" }>): Promise<AdapterEnvironmentTestResult> {
  const unavailable = () => failed("antigravity_remote_runtime_missing",
    "This cloud environment does not have the current Google Antigravity runtime. Use the current Paperclip runner image for this environment.");
  if (target.transport === "sandbox" && target.runnerTask) {
    return failed("antigravity_remote_runtime_missing", "Google Antigravity is unavailable in this hosting environment.");
  }
  const expectedPath = "provider-assets/antigravity/linux-x64";
  const command = [
    `for pack in ${REMOTE_PACK_ROOTS.join(" ")}; do`,
    `  if [ -f "$pack/provider-pack.json" ] && [ -d "$pack/${expectedPath}" ] && [ ! -L "$pack/${expectedPath}" ]; then`,
    '    uname -s; uname -m; head -c 262144 "$pack/provider-pack.json"; exit 0',
    "  fi",
    "done",
    "exit 127",
  ].join("\n");
  let response: Awaited<ReturnType<typeof runAdapterExecutionTargetShellCommand>>;
  try {
    response = await runAdapterExecutionTargetShellCommand(`antigravity-pack-${randomUUID()}`, target, command,
      { cwd: target.remoteCwd, env: {}, timeoutSec: 20 });
  } catch { return failed("antigravity_remote_check_failed", "Paperclip could not reach this cloud environment. Retry Test."); }
  if (response.timedOut) return failed("antigravity_remote_check_failed", "Paperclip could not reach this cloud environment. Retry Test.");
  if (response.exitCode !== 0) return unavailable();
  const [os, arch, ...manifestLines] = response.stdout.split("\n");
  if (os?.trim() !== "Linux" || arch?.trim() !== "x86_64") {
    return failed("antigravity_remote_platform_unsupported", "Google Antigravity needs a Linux x64 cloud environment.");
  }
  let manifest: Record<string, unknown> | null;
  try { manifest = asRecord(JSON.parse(manifestLines.join("\n"))); } catch { return unavailable(); }
  const payload = asRecord(manifest?.payload);
  // While pending, the image lists the candidate closure under candidateProviders.
  const pending = antigravityReleasePending();
  const inventory = pending ? "candidateProviders" : "providers";
  const listed = asRecord(payload?.[inventory]), other = asRecord(payload?.[pending ? "providers" : "candidateProviders"]);
  const entry = asRecord(listed?.antigravity);
  const targetIdentity = asRecord(payload?.target);
  if (!entry || entry.path !== expectedPath || entry.qualification !== (pending ? "pending" : "qualified")
    || typeof entry.version !== "string" || typeof entry.profileDigest !== "string" || typeof entry.closureDigest !== "string"
    || antigravityProviderPackEntryRefusal({ inventory, inBoth: Boolean(other?.antigravity),
      target: { platform: String(targetIdentity?.platform), architecture: String(targetIdentity?.architecture) },
      entry: { version: entry.version, profileDigest: entry.profileDigest, closureDigest: entry.closureDigest },
      releasePending: pending, profile: QUALIFIED_ACPX_PROFILES.antigravity,
      patchedClosures: ANTIGRAVITY_PATCHED_CLOSURE_SHA256 })) {
    return unavailable();
  }
  return { adapterType: "paperclip_runner", status: "warn", testedAt: new Date().toISOString(),
    checks: [{ code: "antigravity_remote_runtime_ready", level: "warn",
      message: "This cloud environment has the verified Google Antigravity runtime. Google checks the API key and the selected model when the agent first runs. No prompt was sent." }] };
}

/** The ordinary Test uses the selected connection and no model turn. */
export async function testAntigravityConnection(context: AdapterEnvironmentTestContext, model: string): Promise<AdapterEnvironmentTestResult> {
  const configured = context.config.env;
  const configuredKey = asRecord(configured)?.GEMINI_API_KEY;
  const pending = antigravityReleasePending();
  const target = context.executionTarget;
  const remote = target?.kind === "remote";
  const refusal = antigravityConnectionRefusal({ apiKey: typeof configuredKey === "string" && configuredKey.trim().length > 0,
    remote, releasePending: pending,
    remoteCandidateAdmitted: remote && pending && antigravityRemoteCandidateAdmitted({ companyId: context.companyId, model }) });
  if (refusal) return failed(refusal.code, refusal.message);
  if (target?.kind === "remote") return probeAntigravityExecutionTarget(target);
  // Only the pending candidate needs the operator's grant; a released profile carries none.
  const admission = pending ? resolveAntigravityCandidateAdmission({ companyId: context.companyId, model,
    target: { platform: process.platform, architecture: process.arch } }) : undefined;
  if (pending && !admission) throw new Error("Google Antigravity is not available for this company.");
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
      acpxAgent: "antigravity", ...(admission ? { acpxCandidateAdmission: admission } : {}), acpxRuntimeDirectory,
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
      message: "Google Antigravity verified the selected connection and exact model. No model prompt was sent." }] };
}
