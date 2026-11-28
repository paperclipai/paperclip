export const GROK_PERMISSION_BYPASS_MODES: ReadonlySet<string> = new Set(["always-approve", "bypassPermissions", "yolo"]);

export class GrokPolicyViolationError extends Error {
  readonly code = "GROK_POLICY_VIOLATION";
  readonly retryable = false;
  constructor() {
    super("Grok session configuration cannot preserve the admitted permission policy.");
    this.name = "GrokPolicyViolationError";
  }
}

export function createGrokPermissionGuard(): (direction: "inbound" | "outbound", value: unknown) => void {
  let failure: GrokPolicyViolationError | undefined;
  return (direction, value) => {
    if (failure) throw failure;
    const message = record(value);
    const params = record(message.params);
    const update = record(params.update);
    const bypass = direction === "outbound"
      ? message.method === "session/set_mode" && isBypassMode(params.modeId)
      : message.method === "_x.ai/sessions/changed"
        ? Array.isArray(params.upserted) && params.upserted.some(session => record(session).yolo === true)
        : message.method === "session/update" && update.sessionUpdate === "current_mode_update" && isBypassMode(update.currentModeId);
    if (!bypass) return;
    failure = new GrokPolicyViolationError();
    throw failure;
  };
}

function isBypassMode(value: unknown): boolean {
  return typeof value === "string" && GROK_PERMISSION_BYPASS_MODES.has(value);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
