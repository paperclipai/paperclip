// VIR-880 / VIR-881: helper that copies the parent-supplied local-agent JWT
// into the child env and emits a structured `jwt_env_race` telemetry event
// when the server-side token was set but the child env arrived empty. This
// isolates the race condition observed in the 18:35-18:44 / 18:45-19:15 /
// 19:20-20:07 plan_only clusters from a plain missing-secret case (which now
// fails fast in the heartbeat with `errorCode: missing_local_agent_jwt`).
//
// Kept as a pure function (no I/O, no shared logger dependency) so the smoke
// test in jwt-env.test.ts can drive it deterministically.

export const JWT_ENV_RACE_EVENT = "jwt_env_race";
export const JWT_ENV_RACE_ERROR_CODE = "jwt_env_race";

export type JwtEnvTelemetry = {
  level: "error";
  event: typeof JWT_ENV_RACE_EVENT;
  errorCode: typeof JWT_ENV_RACE_ERROR_CODE;
  timestamp: string;
  runId: string | null;
  issueId: string | null;
  agentId: string | null;
  adapterType: string | null;
  message: string;
};

export type ApplyLocalAgentJwtOptions = {
  env: Record<string, string>;
  parentAuthToken: string | null;
  runId: string | null;
  issueId: string | null;
  agentId: string | null;
  adapterType: string | null;
  onTelemetry?: (event: JwtEnvTelemetry) => void;
  /** Override timestamp for deterministic tests. */
  now?: () => Date;
};

export type ApplyLocalAgentJwtResult = {
  raced: boolean;
  previousHadToken: boolean;
  appliedToken: boolean;
};

export function applyLocalAgentJwtToEnv({
  env,
  parentAuthToken,
  runId,
  issueId,
  agentId,
  adapterType,
  onTelemetry,
  now = () => new Date(),
}: ApplyLocalAgentJwtOptions): ApplyLocalAgentJwtResult {
  const previousValue = env.PAPERCLIP_API_KEY;
  const previousHadToken = typeof previousValue === "string" && previousValue.length > 0;

  if (parentAuthToken !== null) {
    env.PAPERCLIP_API_KEY = parentAuthToken;
  }

  const appliedToken = parentAuthToken !== null;
  const raced = appliedToken && !previousHadToken;

  if (raced && onTelemetry) {
    onTelemetry({
      level: "error",
      event: JWT_ENV_RACE_EVENT,
      errorCode: JWT_ENV_RACE_ERROR_CODE,
      timestamp: now().toISOString(),
      runId,
      issueId,
      agentId,
      adapterType,
      message:
        "PAPERCLIP_API_KEY estava vazio no child env apesar de authToken ter sido setado no servidor. " +
        "Suspeita de race condition / middleware que zerou o env do spawn.",
    });
  }

  return { raced, previousHadToken, appliedToken };
}
