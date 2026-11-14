type Warning = { method: "warning"; params: { threadId: string; message: string } };
export function createOpenCodeFinishDiagnosticForwarder(send: (frame: Warning) => void) {
  let threadId: string | undefined;
  let offered: Record<string, unknown> | undefined;
  let rejections = 0;
  let coercions = 0;
  const emit = (value: Record<string, unknown>) => {
    if (!threadId) return;
    try { send({ method: "warning", params: { threadId, message: JSON.stringify(value) } }); } catch {}
  };
  return {
    bind(id: string) {
      if (!id || id.length > 512 || threadId) return false;
      threadId = id;
      return true;
    },
    diagnostic(message: string) {
      if (message.length > 2048) return;
      let value: Record<string, unknown>;
      try { value = JSON.parse(message); } catch { return; }
      if (value && typeof value === "object" && !Array.isArray(value)
        && value.schema === "paperclip.opencode.tool-delivery-diagnostic/v1") {
        if (validToolDelivery(value)) emit(value);
        return;
      }
      if (value && typeof value === "object" && !Array.isArray(value)
        && value.schema === "paperclip.runner.tool-input-coerced/v1") {
        if (coercions < 32 && validInputCoercion(value)) { coercions += 1; emit(value); }
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)
        || value.schema !== "paperclip.opencode.finish-input-diagnostic/v1"
        || typeof value.schemaSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.schemaSha256)) return;
      const keys = Object.keys(value).sort().join(",");
      if (value.stage === "offered") {
        if (offered || keys !== "schema,schemaSha256,stage") return;
        offered = value;
      } else if (value.stage === "input_rejected") {
        if (!threadId || !offered || rejections >= 8 || value.schemaSha256 !== offered.schemaSha256
          || keys !== "callIdSha256,continuationShape,rootShape,schema,schemaSha256,stage,validationCategory"
          || typeof value.callIdSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.callIdSha256)
          || typeof value.validationCategory !== "string" || typeof value.rootShape !== "string" || typeof value.continuationShape !== "string"
          || !["root", "continuation", "other"].includes(String(value.validationCategory))
          || !["object", "array", "string", "number", "boolean", "null", "omitted"].includes(String(value.rootShape))
          || !["object", "array", "string", "number", "boolean", "null", "omitted"].includes(String(value.continuationShape))) return;
        if (rejections === 0) emit(offered);
        rejections += 1;
        emit(value);
      }
    },
  };
}

const TOOL_DELIVERY_KEYS = "callIdSha256,handlerMs,outcome,schema,socketIdleMs,socketRequestIndex,written";
// Delivery records carry only hashes, counters and timings. Reject anything
// else so this channel cannot forward tool inputs or results.
function validToolDelivery(value: Record<string, unknown>): boolean {
  const count = (entry: unknown) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0;
  return Object.keys(value).sort().join(",") === TOOL_DELIVERY_KEYS
    && typeof value.callIdSha256 === "string" && /^[a-f0-9]{64}$/.test(value.callIdSha256)
    && count(value.socketRequestIndex) && count(value.handlerMs)
    && (value.socketIdleMs === null || count(value.socketIdleMs))
    && typeof value.outcome === "string" && ["result", "error", "unanswered"].includes(value.outcome)
    && typeof value.written === "boolean";
}

const INPUT_COERCION_KEYS = "callIdSha256,coercion,paths,schema,tool";
// Coercion records name the tool and the repaired field paths only. Reject
// anything else so this channel cannot forward tool inputs.
function validInputCoercion(value: Record<string, unknown>): boolean {
  return Object.keys(value).sort().join(",") === INPUT_COERCION_KEYS
    && typeof value.callIdSha256 === "string" && /^[a-f0-9]{64}$/.test(value.callIdSha256)
    && value.coercion === "json_string_to_object"
    && typeof value.tool === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value.tool)
    && Array.isArray(value.paths) && value.paths.length > 0 && value.paths.length <= 32
    && value.paths.every(path => typeof path === "string" && /^(\/[A-Za-z0-9_.-]{1,64}){1,16}$/.test(path));
}
