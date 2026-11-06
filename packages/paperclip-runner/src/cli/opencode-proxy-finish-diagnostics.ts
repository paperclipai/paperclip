type Warning = { method: "warning"; params: { threadId: string; message: string } };
export function createOpenCodeFinishDiagnosticForwarder(send: (frame: Warning) => void) {
  let threadId: string | undefined;
  let offered: Record<string, unknown> | undefined;
  let rejections = 0;
  const emit = (value: Record<string, unknown>) => {
    if (!threadId) return;
    try { send({ method: "warning", params: { threadId, message: JSON.stringify(value) } }); } catch {}
  };
  return {
    bind(id: string) {
      if (!id || id.length > 512 || threadId) return false;
      threadId = id;
      if (offered) emit(offered);
      return true;
    },
    diagnostic(message: string) {
      if (message.length > 2048) return;
      let value: Record<string, unknown>;
      try { value = JSON.parse(message); } catch { return; }
      if (!value || typeof value !== "object" || Array.isArray(value)
        || value.schema !== "paperclip.opencode.finish-input-diagnostic/v1"
        || typeof value.schemaSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.schemaSha256)) return;
      const keys = Object.keys(value).sort().join(",");
      if (value.stage === "offered") {
        if (offered || keys !== "schema,schemaSha256,stage") return;
        offered = value;
        emit(value);
      } else if (value.stage === "input_rejected") {
        if (!threadId || !offered || rejections >= 8 || value.schemaSha256 !== offered.schemaSha256
          || keys !== "callIdSha256,continuationShape,rootShape,schema,schemaSha256,stage,validationCategory"
          || typeof value.callIdSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.callIdSha256)
          || typeof value.validationCategory !== "string" || typeof value.rootShape !== "string" || typeof value.continuationShape !== "string"
          || !["root", "continuation", "other"].includes(String(value.validationCategory))
          || !["object", "array", "string", "number", "boolean", "null", "omitted"].includes(String(value.rootShape))
          || !["object", "array", "string", "number", "boolean", "null", "omitted"].includes(String(value.continuationShape))) return;
        rejections += 1;
        emit(value);
      }
    },
  };
}
