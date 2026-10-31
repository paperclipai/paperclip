import { KIMI_DISTRIBUTION_CLOSURE_SHA256 } from "./kimi-closure-pins.js";
import { ANTIGRAVITY_DISTRIBUTION_PINS } from "./generated-profiles.js";
import { QUALIFIED_ACPX_PROFILES, assertAcpxProfileReleased, type QualifiedAcpxProfile } from "./qualified-profiles.js";

/** Operator authority travels only through trusted Runner startup, never agent configuration. */
export interface AcpxCandidateAdmission {
  schema: "paperclip.acpx-candidate-admission.v1";
  companyId: string;
  agent: "antigravity" | "kimi";
  model: string;
  profileDigest: string;
  nativeClosureDigest: string;
  platform: "darwin" | "linux";
  architecture: "arm64" | "x64";
  expiresAt: number;
}

/** Runner binds operator authority to its actual launch identity. */
export interface AcpxCandidateStartupAdmission extends AcpxCandidateAdmission {
  runId: string;
  normalizedSessionId: string;
}

const BASE_FIELDS = ["schema", "companyId", "agent", "model", "profileDigest", "nativeClosureDigest", "platform", "architecture", "expiresAt"];
const stableId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value);
const invalid = (): never => { throw Object.assign(new Error("ACPX candidate admission is missing, expired, or does not match the exact authorized execution"), { code: "ACPX_CANDIDATE_ADMISSION_INVALID", retryable: false }); };

export function parseAcpxCandidateAdmission(
  value: unknown,
  expected: { companyId: string; agent: string; model: string },
  now = Date.now(),
): AcpxCandidateAdmission {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const entry = value as Record<string, unknown>;
  const profile = entry.agent === "antigravity" ? QUALIFIED_ACPX_PROFILES.antigravity
    : entry.agent === "kimi" ? QUALIFIED_ACPX_PROFILES.kimi : undefined;
  const target = `${entry.platform}-${entry.architecture}`;
  const closure = entry.agent === "antigravity" && target === "darwin-arm64"
    ? ANTIGRAVITY_DISTRIBUTION_PINS["darwin-arm64"].closureSha256
    : entry.agent === "kimi" && (target === "darwin-arm64" || target === "linux-x64")
      ? KIMI_DISTRIBUTION_CLOSURE_SHA256[target] : undefined;
  if (!Number.isSafeInteger(now) || now < 0 || Object.keys(entry).length !== BASE_FIELDS.length || Object.keys(entry).some(key => !BASE_FIELDS.includes(key))
    || entry.schema !== "paperclip.acpx-candidate-admission.v1"
    || !stableId(entry.companyId) || entry.companyId !== expected.companyId
    || !profile || entry.agent !== expected.agent
    || entry.agent === "kimi" && profile.qualificationStatus !== "pending"
    || typeof entry.model !== "string" || entry.model !== expected.model || !entry.model.trim()
    || entry.model !== entry.model.trim() || Buffer.byteLength(entry.model) > 512 || /[\u0000-\u001f\u007f]/.test(entry.model)
    || ["auto", "default"].includes(entry.model.toLowerCase())
    || entry.profileDigest !== profile.commandDigest
    || !closure || entry.nativeClosureDigest !== `sha256:${closure}`
    || !Number.isSafeInteger(entry.expiresAt) || Number(entry.expiresAt) <= now
    || Number(entry.expiresAt) > now + 24 * 60 * 60 * 1000) return invalid();
  return { ...entry } as unknown as AcpxCandidateAdmission;
}

export function bindAcpxCandidateAdmission(
  admission: AcpxCandidateAdmission,
  identity: { runId: string; normalizedSessionId: string },
): AcpxCandidateStartupAdmission {
  if (!stableId(identity.runId) || identity.runId.length > 160 || !stableId(identity.normalizedSessionId) || identity.normalizedSessionId.length > 160) return invalid();
  return { ...parseAcpxCandidateAdmission(admission, admission), runId: identity.runId, normalizedSessionId: identity.normalizedSessionId };
}

/** The company field here is only a receipt of upstream authorization. This
 * parser is called on the trusted runner/sidecar startup channel; agent or
 * provider configuration must never be promoted into that channel. */
export function parseAcpxCandidateStartupAdmission(
  value: unknown,
  expected: { agent: string; model: string; runId?: string; normalizedSessionId?: string },
  now = Date.now(),
): AcpxCandidateStartupAdmission {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const { runId, normalizedSessionId, ...base } = value as Record<string, unknown>;
  if (!stableId(runId) || runId.length > 160 || !stableId(normalizedSessionId) || normalizedSessionId.length > 160
    || expected.runId !== undefined && expected.runId !== runId
    || expected.normalizedSessionId !== undefined && expected.normalizedSessionId !== normalizedSessionId) return invalid();
  const admission = parseAcpxCandidateAdmission(base, { ...expected, companyId: String(base.companyId) }, now);
  return { ...admission, runId, normalizedSessionId };
}

/** This exception is deliberately absent from direct driver/config admission. */
export function assertAcpxExecutionAdmission(profile: QualifiedAcpxProfile, candidate?: AcpxCandidateStartupAdmission): void {
  if (candidate === undefined) return assertAcpxProfileReleased(profile.agent);
  parseAcpxCandidateStartupAdmission(candidate, { agent: profile.agent, model: profile.qualificationModel });
  if (candidate.platform !== process.platform || candidate.architecture !== process.arch) return invalid();
  if (profile.commandDigest !== candidate.profileDigest) return invalid();
}
