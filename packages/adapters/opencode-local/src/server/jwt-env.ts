// VIR-880 / VIR-881: pure helper that copies the parent-supplied local-agent JWT
// into the child env and reports what the env looked like before/after the
// assignment. The result lets the call site decide whether the assignment was
// a first-time write, an overwrite, or a no-op.
//
// Note on race detection: this helper cannot detect a true server/child JWT
// race from server-side state alone (it never sees the child process env after
// spawn). The original PR carried a `jwt_env_race` telemetry event fired on
// every fresh first-time write, which produced false positives on every
// authenticated run (Greptile P1, see PR #11333 review). PR 1 (the typed
// `missing_local_agent_jwt` failure in heartbeat.ts) handles the
// configuration-blocker path; child-side reporting is a separate, larger-scope
// effort and is out of scope here.
//
// Kept as a pure function (no I/O, no shared logger dependency) so the smoke
// test in jwt-env.test.ts can drive it deterministically.

export type ApplyLocalAgentJwtOptions = {
  env: Record<string, string>;
  parentAuthToken: string | null;
};

export type ApplyLocalAgentJwtResult = {
  /** Whether `env.PAPERCLIP_API_KEY` was a non-empty string before this call. */
  previousHadToken: boolean;
  /** Whether this call wrote a non-null `parentAuthToken` into the env. */
  appliedToken: boolean;
};

export function applyLocalAgentJwtToEnv({
  env,
  parentAuthToken,
}: ApplyLocalAgentJwtOptions): ApplyLocalAgentJwtResult {
  const previousValue = env.PAPERCLIP_API_KEY;
  const previousHadToken =
    typeof previousValue === "string" && previousValue.length > 0;

  if (parentAuthToken !== null) {
    env.PAPERCLIP_API_KEY = parentAuthToken;
  }

  const appliedToken = parentAuthToken !== null;
  return { previousHadToken, appliedToken };
}
