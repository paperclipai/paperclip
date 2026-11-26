import { PAPERCLIP_RUNNER_ACPX_PROFILES } from "@paperclipai/adapter-utils";
import { isAntigravityNativeTarget, parseAcpxCandidateAdmission, QUALIFIED_ACPX_PROFILES, type AcpxCandidateAdmission, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

/** Trusted operator startup authority, separate from saved agent configuration. */
export const ANTIGRAVITY_CANDIDATE_ADMISSION_ENV = "PAPERCLIP_ACPX_CANDIDATE_ADMISSION";

/** The only target a cloud environment runs Antigravity on: the remote pack's patched linux-x64 closure. */
export const ANTIGRAVITY_REMOTE_TARGET = Object.freeze({ platform: "linux", architecture: "x64" });

/** True when the operator granted this company and exact model a cloud (linux-x64) candidate. */
export function antigravityRemoteCandidateAdmitted(input: { companyId?: string; model?: string }, hostEnvironment: NodeJS.ProcessEnv = process.env): boolean {
  try { return Boolean(input.model && resolveAntigravityCandidateAdmission({ ...input, target: ANTIGRAVITY_REMOTE_TARGET }, hostEnvironment)); }
  catch { return false; }
}

/**
 * The operator's candidate grant for one company and exact model. With a
 * `target`, the grant must name that execution target (this host, or
 * `ANTIGRAVITY_REMOTE_TARGET` for a cloud environment) and its patched
 * closure. Without one (availability surfaces) a grant for this host or for
 * the cloud target is accepted. Other companies get nothing.
 */
export function resolveAntigravityCandidateAdmission(
  input: { companyId?: string; model?: string; target?: { platform: string; architecture: string } },
  hostEnvironment: NodeJS.ProcessEnv = process.env,
): AcpxCandidateAdmission | undefined {
  if (QUALIFIED_ACPX_PROFILES.antigravity.qualificationStatus !== "pending") return undefined;
  const encoded = hostEnvironment[ANTIGRAVITY_CANDIDATE_ADMISSION_ENV];
  if (!encoded || !input.companyId) return undefined;
  const hostNative = isAntigravityNativeTarget(process.platform, process.arch);
  // Only a target with a verified, patched closure can run the native candidate.
  if (input.target && !isAntigravityNativeTarget(input.target.platform, input.target.architecture)) return undefined;
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { throw new Error("Invalid Antigravity candidate admission"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Antigravity candidate admission");
  const record = value as Record<string, unknown>;
  // Other companies receive no candidate surface or execution authority.
  if (record.companyId !== input.companyId) return undefined;
  const admission = parseAcpxCandidateAdmission(value, {
    companyId: input.companyId,
    agent: "antigravity",
    model: input.model ?? (typeof record.model === "string" ? record.model : ""),
  });
  const names = (target: { platform: string; architecture: string }) => admission.platform === target.platform && admission.architecture === target.architecture;
  if (input.target) {
    if (!names(input.target)) throw new Error("Antigravity candidate admission does not match the execution target");
  } else if (!names(ANTIGRAVITY_REMOTE_TARGET) && !names({ platform: process.platform, architecture: process.arch })) {
    // A host without a verified closure has no local surface to refuse.
    if (!hostNative) return undefined;
    throw new Error("Antigravity candidate admission does not match this host");
  } else if (!names(ANTIGRAVITY_REMOTE_TARGET) && !hostNative) {
    return undefined;
  }
  return admission;
}

export function resolveKimiCandidateAdmission(
  input: { companyId?: string; model?: string; target?: { platform: string; architecture: string } },
  hostEnvironment: NodeJS.ProcessEnv = process.env,
): AcpxCandidateAdmission | undefined {
  if (QUALIFIED_ACPX_PROFILES.kimi.qualificationStatus !== "pending") return undefined;
  const encoded = hostEnvironment[ANTIGRAVITY_CANDIDATE_ADMISSION_ENV];
  if (!encoded || !input.companyId) return undefined;
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { throw new Error("Invalid Kimi candidate admission"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Kimi candidate admission");
  const record = value as Record<string, unknown>;
  if (record.companyId !== input.companyId || record.agent !== "kimi") return undefined;
  const admission = parseAcpxCandidateAdmission(value, {
    companyId: input.companyId, agent: "kimi",
    model: input.model ?? (typeof record.model === "string" ? record.model : ""),
  });
  if (input.target && (admission.platform !== input.target.platform || admission.architecture !== input.target.architecture)) {
    throw new Error("Kimi candidate admission does not match the execution target");
  }
  return admission;
}

/** Operator-only admission for an exact candidate/model during qualification. */
export const ACPX_QUALIFICATION_ENV = "PAPERCLIP_RUNNER_ACPX_QUALIFICATION";
export type AcpxQualificationCandidate = "cursor" | "copilot" | "pi" | "kimi";

export function resolveAcpxQualification(
  provider: NativeExecutionInput["provider"] | { kind: "acpx"; agent: string; model: string },
  hostEnvironment: NodeJS.ProcessEnv,
): AcpxQualificationCandidate | undefined {
  if (provider.kind !== "acpx" || !["copilot", "pi"].includes(provider.agent)) return undefined;
  // The server release declaration admits qualified Copilot into the frozen
  // SDK's explicit native transport slot. No operator environment is required.
  // Pi retains the mainline transport and qualification behavior below.
  if (provider.agent === "copilot" && PAPERCLIP_RUNNER_ACPX_PROFILES.some(profile => profile.value === "copilot" && profile.qualified)) {
    if (!provider.model || provider.model !== provider.model.trim() || ["auto", "default"].includes(provider.model.toLowerCase())) {
      throw new Error("GitHub Copilot requires an explicit available model ID");
    }
    return "copilot";
  }
  const encoded = hostEnvironment[ACPX_QUALIFICATION_ENV];
  if (!encoded) return undefined;
  let entries: unknown;
  try { entries = JSON.parse(encoded); } catch { throw new Error("Invalid ACPX qualification authorization"); }
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 4) {
    throw new Error("Invalid ACPX qualification authorization");
  }
  const agents = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "agent,model"
      || !["cursor", "copilot", "pi", "kimi"].includes(entry.agent)
      || typeof entry.model !== "string" || !entry.model.trim() || entry.model !== entry.model.trim()
      || agents.has(entry.agent)) throw new Error("Invalid ACPX qualification authorization");
    agents.add(entry.agent);
  }
  if (!entries.some(entry => entry.agent === provider.agent && entry.model === provider.model)) {
    throw new Error("ACPX qualification requires the explicitly authorized candidate and exact model");
  }
  return provider.agent as AcpxQualificationCandidate;
}
