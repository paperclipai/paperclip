import { PAPERCLIP_RUNNER_ACPX_PROFILES } from "@paperclipai/adapter-utils";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

/** Operator-only admission for an exact candidate/model during qualification. */
export const ACPX_QUALIFICATION_ENV = "PAPERCLIP_RUNNER_ACPX_QUALIFICATION";
export type AcpxQualificationCandidate = "cursor" | "copilot" | "pi";

export function resolveAcpxQualification(
  provider: NativeExecutionInput["provider"] | { kind: "acpx"; agent: string; model: string },
  hostEnvironment: NodeJS.ProcessEnv,
): AcpxQualificationCandidate | undefined {
  if (provider.kind !== "acpx" || !["copilot", "pi"].includes(provider.agent)) return undefined;
  // The server release declaration admits qualified Copilot into the frozen
  // SDK's explicit native transport slot. No operator environment is required.
  // Pending Pi continues through the exact host-only qualification check below.
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
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 3) {
    throw new Error("Invalid ACPX qualification authorization");
  }
  const agents = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "agent,model"
      || !["cursor", "copilot", "pi"].includes(entry.agent)
      || typeof entry.model !== "string" || !entry.model.trim() || entry.model !== entry.model.trim()
      || agents.has(entry.agent)) throw new Error("Invalid ACPX qualification authorization");
    agents.add(entry.agent);
  }
  if (!entries.some(entry => entry.agent === provider.agent && entry.model === provider.model)) {
    throw new Error("ACPX qualification requires the explicitly authorized candidate and exact model");
  }
  return provider.agent as AcpxQualificationCandidate;
}
