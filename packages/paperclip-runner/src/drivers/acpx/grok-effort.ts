export const GROK_ADMISSION_ERROR_CODES = [
  "GROK_EFFORT_ACKNOWLEDGEMENT_MISSING",
  "GROK_EFFORT_MISMATCH",
  "GROK_MODEL_MISMATCH",
  "GROK_SESSION_MISMATCH",
  "GROK_CONFIGURATION_CONFLICT",
  "GROK_CONFIGURATION_DRIFT",
  "GROK_ADMISSION_PROTOCOL_VIOLATION",
] as const;

export type GrokEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export function resolveGrokEffort(agent: string, value: unknown): GrokEffort | undefined {
  if (value === undefined || value === "") return undefined;
  if (agent !== "grok") throw new Error("Grok effort is only supported by Grok");
  if (value !== "minimal" && value !== "low" && value !== "medium" && value !== "high" && value !== "xhigh") throw new Error("Grok effort must be minimal, low, medium, high, or xhigh");
  return value;
}
export function createGrokEffortAdmission(expected: GrokEffort, expectedModel: string) {
  type State = { sessionId: string | null; ready: boolean; error: Error | null };
  let current: State | null = null;
  const failure = (code: typeof GROK_ADMISSION_ERROR_CODES[number], detail: string) =>
    Object.assign(new Error(`Grok effort admission failed: ${detail}`), { code });
  const assertReady = () => {
    if (current?.error) throw current.error;
    if (!current?.sessionId || !current.ready) throw failure("GROK_EFFORT_ACKNOWLEDGEMENT_MISSING", "native session does not acknowledge the selected effort");
  };
  const readAcknowledgement = (result: Record<string, unknown>) => {
    const config = object(object(result._meta)["x.ai/sessionConfig"]);
    const options = Array.isArray(config.options) ? config.options.map(object) : [];
    const selected = options.filter(option => option.category === "mode" && option.selected === true);
    if (selected.length !== 1) throw failure("GROK_EFFORT_ACKNOWLEDGEMENT_MISSING", "native effort selection is missing or ambiguous");
    if (selected[0]!.id !== expected) throw failure("GROK_EFFORT_MISMATCH", "native effort differs from the selected effort");
    const model = object(result.models).currentModelId;
    const selectedModels = options.filter(option => option.category === "model" && option.selected === true);
    if (typeof model !== "string" || !model.trim() || model !== expectedModel
      || selectedModels.length > 1 || selectedModels.length === 1 && selectedModels[0]!.id !== model) {
      throw failure("GROK_MODEL_MISMATCH", "native model acknowledgement conflicts with the selected model");
    }
  };
  return {
    assertReady,
    isReady() { if (current?.error) throw current.error; return current?.ready === true; },
    createGuard() {
      const state: State = { sessionId: null, ready: false, error: null };
      current = state;
      let pending: { id: string | number; method: string; sessionId: unknown } | null = null;
      return (direction: "inbound" | "outbound", value: unknown): void => {
        if (current !== state) throw failure("GROK_ADMISSION_PROTOCOL_VIOLATION", "connection authority was replaced");
        if (state.error) throw state.error;
        const message = object(value), params = object(message.params);
        try {
          if (direction === "outbound") {
            if (message.method === "session/prompt") {
              assertReady();
              if (params.sessionId !== state.sessionId) throw failure("GROK_SESSION_MISMATCH", "prompt belongs to a different session");
            } else if (message.method === "session/new" || message.method === "session/load" || message.method === "session/resume") {
              if (typeof message.id !== "string" && typeof message.id !== "number" || pending) throw failure("GROK_ADMISSION_PROTOCOL_VIOLATION", "uncorrelated or overlapping session admission");
              const meta = object(params._meta);
              if (meta.reasoningEffort !== undefined && meta.reasoningEffort !== expected
                || meta.modelId !== undefined && meta.modelId !== expectedModel) {
                throw failure("GROK_CONFIGURATION_CONFLICT", "native session request conflicts with the bound configuration");
              }
              params._meta = { ...meta, modelId: expectedModel, reasoningEffort: expected };
              state.ready = false; state.sessionId = null;
              pending = { id: message.id, method: message.method, sessionId: params.sessionId };
            } else if (message.method === "session/set_config_option" || message.method === "session/set_model") {
              throw failure("GROK_ADMISSION_PROTOCOL_VIOLATION", "model and effort must be selected when the native session opens");
            }
            return;
          }
          if (message.method === "_x.ai/session_notification" && object(params.update).sessionUpdate === "model_changed") {
            if (!state.ready) return;
            const update = object(params.update);
            if (params.sessionId !== state.sessionId || update.reasoning_effort !== expected
              || update.model_id !== expectedModel) throw failure("GROK_CONFIGURATION_DRIFT", "native model or effort drifted from the selected configuration");
            return;
          }
          if (message.method !== undefined || !pending || message.id !== pending.id) return;
          const request = pending; pending = null;
          if (message.error !== undefined) return;
          const result = object(message.result);
          const sessionId = request.method === "session/new" ? result.sessionId : request.sessionId;
          if (typeof sessionId !== "string" || !sessionId.trim()) throw failure("GROK_SESSION_MISMATCH", "native acknowledgement has no session identity");
          const detail = object(object(result._meta)["x.ai/sessionDetail"]);
          if (result.sessionId !== undefined && result.sessionId !== sessionId
            || detail.sessionId !== undefined && detail.sessionId !== sessionId) throw failure("GROK_SESSION_MISMATCH", "native acknowledgement belongs to a different session");
          readAcknowledgement(result);
          state.sessionId = sessionId; state.ready = true;
        } catch (error) {
          state.error = error instanceof Error ? error : failure("GROK_ADMISSION_PROTOCOL_VIOLATION", "invalid native acknowledgement");
          throw state.error;
        }
      };
    },
  };
}
export function admittedGrokEffort(agent: string, requested: unknown, descriptor: Record<string, unknown>, identity: Record<string, unknown>): GrokEffort | undefined {
  const expected = resolveGrokEffort(agent, requested);
  const effective = resolveGrokEffort(agent, identity.grokEffort);
  if (effective !== expected || descriptor.grokEffort !== expected) throw new Error("Grok effort differs from the admitted configuration");
  return effective;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
