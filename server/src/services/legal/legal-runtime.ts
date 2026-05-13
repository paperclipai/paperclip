import path from "node:path";
import { loadRiskGates } from "./risk-gate-loader.js";
import { loadProfiles, selectProfile } from "./profile-loader.js";
import type {
  ProfileDefinition,
  RiskGateDefinition,
  GateEvaluationContext,
  GateFiring,
} from "./types.js";
import { evaluateGates } from "./risk-gate-engine.js";

export interface LegalRuntime {
  profile: ProfileDefinition;
  gates: Record<string, RiskGateDefinition>;
  evaluate(context: GateEvaluationContext): GateFiring[];
}

export interface LegalRuntimeOptions {
  /** Directory containing `*.yaml` risk-gate definitions. */
  riskGatesDir: string;
  /** Directory containing `*.yaml` profile definitions. */
  profilesDir: string;
  /** Key of the profile to activate (matches `profile:` field in YAML). */
  profileKey: string;
}

/**
 * Boot the legal-layer runtime: load risk-gate definitions and the active
 * profile from disk, then return a runtime object that can evaluate any
 * action against the loaded gates+profile.
 *
 * Called once at server startup for installs where a profile is configured.
 * If no profile is configured the server should skip the boot entirely
 * (i.e. legacy paperclip-only deployments stay untouched).
 *
 * Per sprint-1 Q1 default: profiles + gates are wired in PR-C, but agent
 * runtime stays deferred to sprint-2. The returned runtime is therefore
 * passive: it evaluates and reports, but does not yet hook into the
 * heartbeat or persist legal_approvals records. Persistence + heartbeat
 * integration land in a follow-up PR.
 */
export async function bootLegalRuntime(
  opts: LegalRuntimeOptions,
): Promise<LegalRuntime> {
  const [gates, profiles] = await Promise.all([
    loadRiskGates(opts.riskGatesDir),
    loadProfiles(opts.profilesDir),
  ]);
  const profile = selectProfile(profiles, opts.profileKey);
  return {
    profile,
    gates,
    evaluate(context) {
      return evaluateGates(context, gates, profile);
    },
  };
}

/**
 * Resolve the default repo-root-relative legal-layer paths. The server
 * boots from `server/`, so the legal layer lives two levels up:
 *   <repo-root>/risk-gates/*.yaml
 *   <repo-root>/profiles/*.yaml
 *
 * Callers can pass an override `repoRoot` for tests or custom layouts.
 */
export function defaultLegalLayerPaths(repoRoot: string): {
  riskGatesDir: string;
  profilesDir: string;
} {
  return {
    riskGatesDir: path.join(repoRoot, "risk-gates"),
    profilesDir: path.join(repoRoot, "profiles"),
  };
}
