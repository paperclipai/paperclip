/** Policy for the exact native Copilot 1.0.88 ACP surface. */
export const COPILOT_AGENT_MODE = "https://agentclientprotocol.com/protocol/session-modes#agent";

export class CopilotPolicyViolationError extends Error {
  readonly code: string = "COPILOT_POLICY_VIOLATION";
  readonly retryable = false;
  constructor() {
    super("Copilot session configuration or command cannot preserve the admitted permission policy.");
    this.name = "CopilotPolicyViolationError";
  }
}

export class CopilotDetachedWorkUnsupportedError extends CopilotPolicyViolationError {
  override readonly code = "COPILOT_DETACHED_WORK_UNSUPPORTED";
  constructor() {
    super();
    this.name = "CopilotDetachedWorkUnsupportedError";
    this.message = "Native detached commands are unsupported in this Copilot runner. Run the command attached or use a managed runtime service.";
  }
}

/**
 * Native ACP interprets a leading slash as a CLI command, before inference.
 * Reject every such command rather than maintaining an incomplete list of
 * aliases/skills that can change mode, permissions, cwd, MCP or remote state.
 * Apply to the final joined ACP text, including resumed prompts.
 */
export function assertCopilotPromptPolicy(text: string): void {
  if (text.trimStart().startsWith("/")) throw new CopilotPolicyViolationError();
}

/** Only explicit model selection is a runner-owned configuration operation. */
export function assertCopilotControlPolicy(method: string, params: unknown, expectedModel: string): void {
  const input = record(params);
  if (!expectedModel || expectedModel === "auto") throw new CopilotPolicyViolationError();
  if (method === "session/set_model" && input.modelId === expectedModel) return;
  if (method === "session/set_config_option" && input.configId === "model" && input.value === expectedModel) return;
  throw new CopilotPolicyViolationError();
}

/**
 * Validate the actual new/load response on every connection, before prompting.
 * Persisted ACPX status is insufficient: load can restore autopilot and turn
 * allow-all back on inside the native server. Missing proof fails closed.
 */
export function assertCopilotSessionPolicy(response: unknown): void {
  const state = record(response);
  if (record(state.modes).currentModeId !== COPILOT_AGENT_MODE) throw new CopilotPolicyViolationError();
  assertCopilotConfigPolicy(state.configOptions);
}

/** Copilot emits full config snapshots, not patches, in config_option_update. */
export function assertCopilotConfigPolicy(value: unknown): void {
  if (!Array.isArray(value) || value.length > 32) throw new CopilotPolicyViolationError();
  const options = new Map<string, Record<string, unknown>>();
  for (const candidate of value) {
    const option = record(candidate);
    if (typeof option.id !== "string" || options.has(option.id)) throw new CopilotPolicyViolationError();
    options.set(option.id, option);
    if (!["mode", "allow_all", "model", "reasoning_effort", "agent"].includes(option.id)) throw new CopilotPolicyViolationError();
    if (option.id === "agent" && option.currentValue !== "") throw new CopilotPolicyViolationError();
  }
  if (options.get("mode")?.currentValue !== COPILOT_AGENT_MODE || options.get("allow_all")?.currentValue !== "off") {
    throw new CopilotPolicyViolationError();
  }
}

/** Reject native detachment before permission handling, regardless of tool name. */
export function assertCopilotToolPolicy(value: unknown): void {
  if (record(record(value).rawInput).detach === true) throw new CopilotDetachedWorkUnsupportedError();
}

/** Call synchronously for owned-session updates; any exception aborts authority. */
export function assertCopilotSessionUpdatePolicy(value: unknown): void {
  const update = record(value);
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") assertCopilotToolPolicy(update);
  if (update.sessionUpdate === "current_mode_update" && update.currentModeId !== COPILOT_AGENT_MODE) {
    throw new CopilotPolicyViolationError();
  }
  if (update.sessionUpdate === "config_option_update") assertCopilotConfigPolicy(update.configOptions);
}

/** One guard per actual stdio connection; never restore admission from disk. */
export function createCopilotProtocolGuard(expectedModel: string): (direction: "inbound" | "outbound", value: unknown) => void {
  const pending = new Map<string | number, { method: string; sessionId?: string }>();
  const sessions = new Set<string>();
  const models = new Map<string, unknown>();
  const modelFrom = (result: unknown) => {
    const options = record(result).configOptions;
    return Array.isArray(options) ? record(options.find(option => record(option).id === "model")).currentValue : undefined;
  };
  let failure: CopilotPolicyViolationError | undefined;
  return (direction, value) => {
    if (failure) throw failure;
    try {
      const message = record(value);
      const params = record(message.params);
      const id = message.id;
      const method = message.method;
      if (direction === "outbound" && typeof method === "string") {
        if (method.startsWith("session/") && !["session/new", "session/load", "session/resume"].includes(method)) {
          if (typeof params.sessionId !== "string" || !sessions.has(params.sessionId)) throw new CopilotPolicyViolationError();
        }
        if (method === "session/prompt") {
          if (models.get(String(params.sessionId)) !== expectedModel) throw new CopilotPolicyViolationError();
          if (!Array.isArray(params.prompt) || params.prompt.some(block => record(block).type !== "text" || typeof record(block).text !== "string")) throw new CopilotPolicyViolationError();
          assertCopilotPromptPolicy(params.prompt.map(block => record(block).text).join("\n"));
        } else if (method.startsWith("session/set_")) {
          assertCopilotControlPolicy(method, params, expectedModel);
        } else if (!["initialize", "authenticate", "session/new", "session/load", "session/resume", "session/cancel", "session/close"].includes(method)) {
          throw new CopilotPolicyViolationError();
        }
        if (typeof id === "string" || typeof id === "number") {
          if (pending.has(id) || pending.size >= 128) throw new CopilotPolicyViolationError();
          pending.set(id, { method, ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}) });
        }
      }
      if (direction === "inbound" && method === undefined && (typeof id === "string" || typeof id === "number")) {
        const request = pending.get(id);
        pending.delete(id);
        if (request && message.error === undefined) {
          if (["session/new", "session/load", "session/resume"].includes(request.method)) {
            assertCopilotSessionPolicy(message.result);
            const sessionId = request.sessionId ?? record(message.result).sessionId;
            if (typeof sessionId !== "string" || !sessionId) throw new CopilotPolicyViolationError();
            sessions.add(sessionId);
            models.set(sessionId, modelFrom(message.result));
          } else if (request.method === "session/set_config_option") {
            assertCopilotConfigPolicy(record(message.result).configOptions);
            if (request.sessionId) models.set(request.sessionId, modelFrom(message.result));
          } else if (request.method === "session/set_model" && request.sessionId) {
            models.set(request.sessionId, expectedModel);
          } else if (request.method === "session/close" && request.sessionId) sessions.delete(request.sessionId);
        }
      }
      if (direction === "inbound" && method === "session/request_permission") assertCopilotToolPolicy(params.toolCall);
      if (direction === "inbound" && method === "session/update") {
        // Replay can precede load's response. It still cannot introduce unsafe
        // configuration, and it cannot grant admission before that response.
        assertCopilotSessionUpdatePolicy(params.update);
        if (record(params.update).sessionUpdate === "config_option_update" && typeof params.sessionId === "string" && sessions.has(params.sessionId)) {
          const model = modelFrom(params.update);
          if (models.get(params.sessionId) === expectedModel && model !== expectedModel) throw new CopilotPolicyViolationError();
          models.set(params.sessionId, model);
        }
      }
      if (direction === "inbound" && method === "github.com/copilot/sessionEvent") {
        if (["user_input.requested", "exit_plan_mode.requested", "elicitation.requested"].includes(String(params.type))) throw new CopilotPolicyViolationError();
        const data = record(params.data);
        if (params.type === "session.permissions_changed" && data.mode !== "manual") throw new CopilotPolicyViolationError();
        if (params.type === "session.mode_changed" && data.newMode !== "interactive" && data.newMode !== "agent") throw new CopilotPolicyViolationError();
      }
    } catch (error) {
      failure = error instanceof CopilotPolicyViolationError ? error : new CopilotPolicyViolationError();
      sessions.clear();
      models.clear();
      pending.clear();
      throw failure;
    }
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
