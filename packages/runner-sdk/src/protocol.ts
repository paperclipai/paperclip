import {
  HARNESS_PROTOCOL_SCHEMA, HARNESS_MAX_FRAME_BYTES, HarnessProtocolError,
  type HarnessCommand, type HarnessEvent, type HarnessMethod, type HarnessRequest, type HarnessResponse,
} from "./types.js";
import { exactKeys, jsonObject, jsonValue, positiveInteger, record, text } from "./validation.js";

export function parseHarnessCommand(value: unknown): HarnessCommand {
  const fields = record(value, "command");
  exactKeys(fields, ["schema", "commandId", "controllerSeq", "type", "issuedAt", "deadlineAt", "precondition", "payload"], "command");
  if (!["paperclip.prp.command.v1", "paperclip.prp.command.v2", "paperclip.prp.command.v3"].includes(String(fields.schema))) throw new HarnessProtocolError("unsupported runner command schema");
  const result: HarnessCommand = {
    schema: fields.schema as HarnessCommand["schema"],
    commandId: text(fields.commandId, "command.commandId", 160),
    controllerSeq: positiveInteger(fields.controllerSeq, "command.controllerSeq"),
    type: text(fields.type, "command.type", 160),
    issuedAt: text(fields.issuedAt, "command.issuedAt", 100),
    payload: jsonObject(fields.payload, "command.payload"),
  };
  if (fields.deadlineAt !== undefined) result.deadlineAt = fields.deadlineAt === null ? null : text(fields.deadlineAt, "command.deadlineAt", 100);
  if (fields.precondition !== undefined) result.precondition = fields.precondition === null ? null : jsonObject(fields.precondition, "command.precondition");
  return result;
}

export function parseHarnessRequest(value: unknown): HarnessRequest {
  const fields = record(value, "request");
  exactKeys(fields, ["schema", "id", "method", "params"], "request");
  if (fields.schema !== HARNESS_PROTOCOL_SCHEMA) throw new HarnessProtocolError("unsupported harness protocol");
  if (!["initialize", "execute", "snapshot", "close"].includes(String(fields.method))) throw new HarnessProtocolError("unknown harness method");
  const params = jsonObject(fields.params, "request.params");
  if (fields.method === "execute") {
    exactKeys(params, ["command"], "execute.params");
    parseHarnessCommand(params.command);
  }
  const result: HarnessRequest = { schema: HARNESS_PROTOCOL_SCHEMA,
    id: positiveInteger(fields.id, "request.id"), method: fields.method as HarnessMethod, params };
  jsonValue(result, "request");
  return result;
}

export function parseHarnessResponse(value: unknown): HarnessResponse {
  const fields = record(value, "response");
  if (fields.schema !== HARNESS_PROTOCOL_SCHEMA) throw new HarnessProtocolError("unsupported harness protocol");
  const id = positiveInteger(fields.id, "response.id");
  let result: HarnessResponse;
  if (fields.ok === true) {
    exactKeys(fields, ["schema", "id", "ok", "result"], "response");
    result = { schema: HARNESS_PROTOCOL_SCHEMA, id, ok: true, result: jsonObject(fields.result, "response.result") };
  } else if (fields.ok === false) {
    exactKeys(fields, ["schema", "id", "ok", "error"], "response");
    const error = record(fields.error, "response.error");
    exactKeys(error, ["code", "message", "retryable"], "response.error");
    if (typeof error.retryable !== "boolean") throw new HarnessProtocolError("response.error.retryable must be a boolean");
    result = { schema: HARNESS_PROTOCOL_SCHEMA, id, ok: false, error: {
      code: text(error.code, "response.error.code", 160), message: text(error.message, "response.error.message", 8192), retryable: error.retryable,
    } };
  } else throw new HarnessProtocolError("response.ok must be a boolean");
  jsonValue(result, "response");
  return result;
}

export function parseHarnessEvent(value: unknown): HarnessEvent {
  const fields = record(value, "event");
  exactKeys(fields, ["schema", "sequence", "eventType", "priority", "turnId", "itemId", "payload"], "event");
  if (fields.schema !== HARNESS_PROTOCOL_SCHEMA || !["p0", "p1", "p2"].includes(String(fields.priority))) throw new HarnessProtocolError("invalid harness event protocol or priority");
  const result: HarnessEvent = { schema: HARNESS_PROTOCOL_SCHEMA,
    sequence: positiveInteger(fields.sequence, "event.sequence"), eventType: text(fields.eventType, "event.eventType", 160),
    priority: fields.priority as HarnessEvent["priority"], payload: jsonObject(fields.payload, "event.payload") };
  if (fields.turnId !== undefined) result.turnId = fields.turnId === null ? null : text(fields.turnId, "event.turnId", 160);
  if (fields.itemId !== undefined) result.itemId = fields.itemId === null ? null : text(fields.itemId, "event.itemId", 160);
  jsonValue(result, "event");
  return result;
}

export function serializeHarnessFrame(value: HarnessRequest | HarnessResponse | HarnessEvent): string {
  const validated = "method" in value ? parseHarnessRequest(value)
    : "ok" in value ? parseHarnessResponse(value) : parseHarnessEvent(value);
  const frame = JSON.stringify(validated);
  if (new TextEncoder().encode(frame).length > HARNESS_MAX_FRAME_BYTES) throw new HarnessProtocolError("harness frame exceeds byte limit");
  return `${frame}\n`;
}

export function parseHarnessFrameText(text: string): unknown {
  if (new TextEncoder().encode(text).length > HARNESS_MAX_FRAME_BYTES) throw new HarnessProtocolError("harness frame exceeds byte limit");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new HarnessProtocolError("harness frame must be valid JSON"); }
  return jsonValue(value, "frame");
}
