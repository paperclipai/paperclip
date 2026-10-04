export type CursorSessionMode = "agent" | "plan" | "ask";

export function resolveCursorSessionMode(agent: string, mode: unknown): CursorSessionMode | undefined {
  if (agent !== "cursor") {
    if (mode !== undefined) throw new Error("Cursor session mode is only supported by Cursor");
    return undefined;
  }
  if (mode === undefined) return "agent";
  if (mode !== "agent" && mode !== "plan" && mode !== "ask") throw new Error("Invalid Cursor session mode");
  return mode;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Native mode is independent of permissions. Every connection must prove its
 * current mode before a prompt; a persisted ACPX preference is not proof. */
export function createCursorModeAdmission(expected: CursorSessionMode) {
  type State = { sessionId: string | null; mode: CursorSessionMode | null; error: Error | null };
  let current: State | null = null;
  const failure = (detail: string) => new Error(`Cursor mode admission failed: ${detail}`);
  const assertReady = () => {
    if (current?.error) throw current.error;
    if (!current?.sessionId || current.mode !== expected) throw failure("native mode does not acknowledge the selected mode");
  };
  const readMode = (result: Record<string, unknown>, session: boolean): CursorSessionMode => {
    const configs = Array.isArray(result.configOptions) ? result.configOptions.filter(value => object(value).id === "mode") : [];
    if (configs.length !== 1) throw failure("native mode configuration is missing or ambiguous");
    const mode = object(configs[0]).currentValue;
    if (mode !== "agent" && mode !== "plan" && mode !== "ask") throw failure("native mode is unsupported");
    if (session && object(result.modes).currentModeId !== mode) throw failure("native mode acknowledgements conflict");
    return mode;
  };
  return {
    assertReady,
    isReady() { assertNoError(); return current?.sessionId != null && current.mode === expected; },
    createGuard() {
      const state: State = { sessionId: null, mode: null, error: null };
      current = state;
      const pending = new Map<string | number, { method: string; sessionId: unknown; selectsMode: boolean }>();
      return (direction: "inbound" | "outbound", value: unknown): void => {
        if (current !== state) throw failure("connection authority was replaced");
        assertNoError();
        const message = object(value);
        const params = object(message.params);
        try {
          if (direction === "outbound") {
            const method = message.method;
            if (method === "session/prompt") {
              assertReady();
              if (params.sessionId !== state.sessionId) throw failure("prompt belongs to a different session");
            } else if (method === "session/new" || method === "session/load" || method === "session/set_config_option") {
              if (typeof message.id !== "string" && typeof message.id !== "number") throw failure("uncorrelated mode request");
              if (pending.has(message.id)) throw failure("duplicate mode request identity");
              if (method === "session/new" || method === "session/load") {
                if (pending.size) throw failure("overlapping session admission");
                state.sessionId = null; state.mode = null;
              } else {
                if (!state.sessionId || params.sessionId !== state.sessionId) throw failure("configuration belongs to a different session");
                if (params.configId === "mode" && params.value !== expected) throw failure("configuration changes the selected mode");
              }
              pending.set(message.id, { method, sessionId: params.sessionId, selectsMode: params.configId === "mode" });
            } else if (method === "session/set_mode") {
              if (!state.sessionId || params.sessionId !== state.sessionId || params.modeId !== expected) throw failure("mode control changes the selected mode");
              // This method only returns {}; require a later config/session
              // acknowledgement rather than treating that empty result as proof.
              state.mode = null;
            }
            return;
          }
          if (message.method === "session/update" && object(params.update).sessionUpdate === "config_option_update") {
            const update = object(params.update);
            // Config updates may contain only model options. A mode entry is
            // authoritative observation, but never an admission acknowledgement.
            if (Array.isArray(update.configOptions) && update.configOptions.some(value => object(value).id === "mode")) {
              if (!state.sessionId || params.sessionId !== state.sessionId) throw failure("mode update belongs to a different session");
              if (readMode(update, false) !== expected) throw failure("native mode drifted from the selected mode");
            }
            return;
          }
          if (message.method === "session/update" && object(params.update).sessionUpdate === "current_mode_update") {
            if (!state.sessionId || params.sessionId !== state.sessionId) throw failure("mode update belongs to a different session");
            if (object(params.update).currentModeId !== expected) throw failure("native mode drifted from the selected mode");
            return; // Notifications alone never admit a prompt.
          }
          if (message.method !== undefined || (typeof message.id !== "string" && typeof message.id !== "number")) return;
          const request = pending.get(message.id);
          if (!request) return;
          pending.delete(message.id);
          if (message.error !== undefined) { state.mode = null; return; }
          const result = object(message.result);
          const session = request.method !== "session/set_config_option";
          const sessionId = request.method === "session/new" ? result.sessionId : request.sessionId;
          if (typeof sessionId !== "string" || !sessionId.trim()) throw failure("mode acknowledgement has no session identity");
          const mode = readMode(result, session);
          if (!session && (request.selectsMode || state.mode === expected) && mode !== expected) throw failure("configuration did not apply the selected mode");
          state.sessionId = sessionId; state.mode = mode;
        } catch (error) {
          state.error = error instanceof Error ? error : failure("invalid mode acknowledgement");
          throw state.error;
        }
      };
    },
  };
  function assertNoError() { if (current?.error) throw current.error; }
}
