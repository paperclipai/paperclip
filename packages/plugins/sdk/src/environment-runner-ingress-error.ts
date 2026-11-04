const SCHEMA = "paperclip/environment-runner-ingress-error/v1";
const PHASES = ["sandbox_lookup", "sandbox_start", "sandbox_refresh", "private_preview"] as const;

export interface PluginEnvironmentRunnerIngressFailure {
  phase: typeof PHASES[number];
  httpStatus: number;
}

function field(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try { return Object.getOwnPropertyDescriptor(value, name)?.value; }
  catch { return undefined; }
}

function validate(value: unknown): PluginEnvironmentRunnerIngressFailure | null {
  const phase = field(value, "phase"), httpStatus = field(value, "httpStatus");
  if (!PHASES.includes(phase as PluginEnvironmentRunnerIngressFailure["phase"])
    || typeof httpStatus !== "number" || !Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus > 599) return null;
  return { phase: phase as PluginEnvironmentRunnerIngressFailure["phase"], httpStatus };
}

export class PluginEnvironmentRunnerIngressError extends Error {
  constructor(public readonly failure: PluginEnvironmentRunnerIngressFailure) {
    const safe = validate(failure);
    super(`Runner connection endpoint could not be acquired${safe ? ` (HTTP ${safe.httpStatus})` : ""}.`);
    this.name = "PluginEnvironmentRunnerIngressError";
  }
}

export function environmentRunnerIngressErrorData(error: unknown): unknown {
  if (!(error instanceof PluginEnvironmentRunnerIngressError)) return undefined;
  const failure = validate(field(error, "failure"));
  return failure ? { schema: SCHEMA, failure } : undefined;
}

export function readEnvironmentRunnerIngressFailure(error: unknown): PluginEnvironmentRunnerIngressFailure | null {
  const data = field(error, "data");
  return field(data, "schema") === SCHEMA ? validate(field(data, "failure")) : null;
}
