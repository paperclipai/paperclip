import { assertAcpxExecutionAdmission, type AcpxCandidateStartupAdmission } from "./candidate-admission.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { KIMI_DISTRIBUTION_CLOSURE_SHA256, KIMI_NODE_DISTRIBUTIONS, KIMI_NODE_VERSION, KIMI_RUNTIME_VERSION } from "./kimi-closure-pins.js";
import { verifyKimiInstallation } from "./kimi-installation.js";
import { KimiMetadataProbeError, probeKimiModels, type KimiMetadataProbeErrorCode } from "./kimi-models.js";
import { resolveQualifiedAcpxProfile, QUALIFIED_ACPX_PROFILES } from "./qualified-profiles.js";

const SCHEMA = "paperclip.kimi.metadata.v1";
const providerCodes = ["KIMI_AUTH_REQUIRED", "KIMI_AUTH_REJECTED", "KIMI_MODEL_UNAVAILABLE", "KIMI_METADATA_TIMEOUT", "KIMI_METADATA_INVALID", "KIMI_PROVIDER_ERROR"] as const;
type FailureCode = KimiMetadataProbeErrorCode | "KIMI_INSTALLATION_INVALID" | "KIMI_REQUEST_FAILED" | "KIMI_QUALIFICATION_REQUIRED";
export type KimiMetadataResult = {
  schema: typeof SCHEMA; status: "verified"; version: typeof KIMI_RUNTIME_VERSION;
  nodeVersion: typeof KIMI_NODE_VERSION; profileDigest: string; target: string;
  closureDigest: string; model: string; contextLength: number; promptSent: false;
} | { schema: typeof SCHEMA; status: "failed"; code: FailureCode; message: string; promptSent: false };

function failed(code: FailureCode): Extract<KimiMetadataResult, { status: "failed" }> {
  const message = code === "KIMI_QUALIFICATION_REQUIRED"
    ? "Kimi Code qualification is pending; metadata verification requires trusted operator admission."
    : code === "KIMI_INSTALLATION_INVALID"
    ? "Install the current verified Kimi Code runtime in this execution environment."
    : code === "KIMI_REQUEST_FAILED" ? "Kimi Code metadata verification failed."
      : new KimiMetadataProbeError(code).message;
  return { schema: SCHEMA, status: "failed", code, message, promptSent: false };
}

export async function probeKimiMetadata(model: string, apiKey: string, candidateAdmission?: AcpxCandidateStartupAdmission): Promise<KimiMetadataResult> {
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\0\r\n]/.test(apiKey) || Buffer.byteLength(apiKey) > 16 * 1024) return failed("KIMI_AUTH_REQUIRED");
  if (typeof model !== "string" || !model.trim() || model.includes("\0") || Buffer.byteLength(model) > 512 || Buffer.from(model).toString("utf8") !== model) return failed("KIMI_MODEL_UNAVAILABLE");
  const target = `${process.platform}-${process.arch}`;
  if (!Object.hasOwn(KIMI_DISTRIBUTION_CLOSURE_SHA256, target)) return failed("KIMI_INSTALLATION_INVALID");
  const profile = resolveQualifiedAcpxProfile("kimi", model);
  try { assertAcpxExecutionAdmission(profile, candidateAdmission); }
  catch { return failed("KIMI_QUALIFICATION_REQUIRED"); }
  try {
    const installation = await verifyKimiInstallation(profile);
    const lease = await installation.openCommand();
    await lease.close();
  } catch { return failed("KIMI_INSTALLATION_INVALID"); }
  try {
    const metadata = await probeKimiModels(model, apiKey);
    return { schema: SCHEMA, status: "verified", version: KIMI_RUNTIME_VERSION, nodeVersion: KIMI_NODE_VERSION,
      profileDigest: QUALIFIED_ACPX_PROFILES.kimi.commandDigest, target,
      closureDigest: `sha256:${KIMI_DISTRIBUTION_CLOSURE_SHA256[target as keyof typeof KIMI_DISTRIBUTION_CLOSURE_SHA256]}`,
      model: metadata.model, contextLength: metadata.contextLength, promptSent: false };
  } catch (error) { return failed(error instanceof KimiMetadataProbeError ? error.code : "KIMI_REQUEST_FAILED"); }
}

export function validateKimiMetadata(value: unknown, model: string): KimiMetadataResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failed("KIMI_REQUEST_FAILED");
  const row = value as Record<string, unknown>;
  if (row.schema !== SCHEMA || row.promptSent !== false) return failed("KIMI_REQUEST_FAILED");
  if (row.status === "failed") {
    if (Object.keys(row).some(key => !["schema", "status", "code", "message", "promptSent"].includes(key))
      || typeof row.code !== "string" || ![...providerCodes, "KIMI_INSTALLATION_INVALID", "KIMI_REQUEST_FAILED", "KIMI_QUALIFICATION_REQUIRED"].includes(row.code)) return failed("KIMI_REQUEST_FAILED");
    return failed(row.code as FailureCode);
  }
  if (row.status !== "verified" || Object.keys(row).some(key => !["schema", "status", "version", "nodeVersion", "profileDigest", "target", "closureDigest", "model", "contextLength", "promptSent"].includes(key))) return failed("KIMI_REQUEST_FAILED");
  if (row.version !== KIMI_RUNTIME_VERSION || row.nodeVersion !== KIMI_NODE_VERSION
    || row.profileDigest !== QUALIFIED_ACPX_PROFILES.kimi.commandDigest || typeof row.target !== "string"
    || !Object.hasOwn(KIMI_DISTRIBUTION_CLOSURE_SHA256, row.target)
    || row.closureDigest !== `sha256:${KIMI_DISTRIBUTION_CLOSURE_SHA256[row.target as keyof typeof KIMI_DISTRIBUTION_CLOSURE_SHA256]}`) return failed("KIMI_INSTALLATION_INVALID");
  if (row.model !== model) return failed("KIMI_MODEL_UNAVAILABLE");
  if (!Number.isSafeInteger(row.contextLength) || (row.contextLength as number) <= 0) return failed("KIMI_METADATA_INVALID");
  return row as Extract<KimiMetadataResult, { status: "verified" }>;
}

export function kimiMetadataProbeNodeDigest(): string {
  return `sha256:${KIMI_NODE_DISTRIBUTIONS["linux-x64"].executableSha256}`;
}

export async function kimiMetadataProbeDigest(): Promise<string> {
  const url = new URL(import.meta.url);
  const relative = /\/dist\/vendor\/paperclip-runner\/drivers\/acpx\/kimi-metadata-probe\.js$/.test(url.pathname)
    ? "../../cli/kimi-metadata-probe.cjs"
    : /\/(?:src|dist)\/drivers\/acpx\/kimi-metadata-probe\.(?:ts|js)$/.test(url.pathname)
      ? "../../../dist/cli/kimi-metadata-probe.cjs" : null;
  if (url.protocol !== "file:" || url.search || url.hash || relative === null) throw new Error("Kimi metadata probe requires its fixed build layout");
  const path = fileURLToPath(new URL(relative, url));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 4n * 1024n * 1024n) throw new Error("Kimi metadata probe artifact is invalid");
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    if (bytes.length !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size
      || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink()) throw new Error("Kimi metadata probe artifact changed during admission");
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  } finally { await file.close(); }
}
