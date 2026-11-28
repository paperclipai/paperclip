import { evalOtlpSchema as root, protobuf } from "./eval-otlp-schema.js";

export type EvalOtlpSignal = "traces" | "logs";
export const isEvalProjectId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function validateEvalOtlpParent(value: string, projectId: string, expectedParent?: string): string {
  if (expectedParent !== undefined && value !== expectedParent) throw new Error("unexpected_otlp_parent");
  if (!isEvalProjectId(projectId)) throw new Error("invalid_otlp_project");
  if (value === `project_id:${projectId}`) return value;
  if (value.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("invalid_otlp_parent");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || !bytes.subarray(0, 3).equals(Buffer.from([4, 2, 0]))) throw new Error("invalid_otlp_parent");
  const data = JSON.parse(bytes.subarray(3).toString("utf8"));
  if (!data || Array.isArray(data) || Object.keys(data).sort().join(",") !== "object_id,root_span_id,row_id,span_id"
    || data.object_id !== projectId || data.row_id !== data.span_id
    || !/^[0-9a-f]{16}$/.test(data.span_id) || /^0+$/.test(data.span_id)
    || !/^[0-9a-f]{32}$/.test(data.root_span_id) || /^0+$/.test(data.root_span_id)) throw new Error("invalid_otlp_parent");
  return value;
}

function validateWire(body: Buffer, type: import("../../server/node_modules/protobufjs/index.js").Type) {
  const reader = protobuf.Reader.create(body);
  let fields = 0;
  const inspect = (message: typeof type, end: number, depth: number): void => {
    if (depth > 64) throw new Error("otlp_structure_limit");
    const seen = new Set<number | string>();
    while (reader.pos < end) {
      if (++fields > 200_000) throw new Error("otlp_structure_limit");
      const tag = reader.uint32(), id = tag >>> 3, wire = tag & 7, field = message.fieldsById[id];
      if (!id || ![0, 1, 2, 5].includes(wire)) throw new Error("invalid_otlp_wire");
      if (field) {
        if (!field.repeated && seen.has(id) || field.partOf && seen.has(field.partOf.name)) throw new Error("ambiguous_otlp_wire");
        seen.add(id); if (field.partOf) seen.add(field.partOf.name);
        const nested = field.resolvedType instanceof protobuf.Type ? field.resolvedType : undefined;
        const expected = nested || ["string", "bytes"].includes(field.type) ? 2
          : ["double", "fixed64", "sfixed64"].includes(field.type) ? 1
          : ["float", "fixed32", "sfixed32"].includes(field.type) ? 5 : 0;
        if (wire !== expected) throw new Error("invalid_otlp_wire");
        if (nested) {
          const length = reader.uint32(), next = reader.pos + length;
          if (next > end) throw new Error("invalid_otlp_wire");
          inspect(nested, next, depth + 1);
        } else reader.skipType(wire);
      } else throw new Error("unqualified_otlp_field");
      if (reader.pos > end) throw new Error("invalid_otlp_wire");
    }
  };
  inspect(type, body.length, 0);
}

export function validateEvalOtlpPayload(body: Buffer, contentType: string, signal: EvalOtlpSignal, projectId: string, expectedParent?: string) {
  const type = root.lookupType(signal === "traces" ? "TracesData" : "LogsData");
  if (contentType !== "application/json") validateWire(body, type);
  const decoded: unknown = contentType === "application/json" ? JSON.parse(body.toString("utf8")) : type.decode(body).toJSON();
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid_otlp_payload");
  let visited = 0;
  const inspect = (value: unknown, depth: number): void => {
    if (++visited > 200_000 || depth > 64) throw new Error("otlp_structure_limit");
    if (Array.isArray(value)) { value.forEach(item => inspect(item, depth + 1)); return; }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (row.key === "braintrust.parent") {
      const parent = row.value as { stringValue?: unknown; string_value?: unknown } | undefined;
      if (!parent || Object.keys(parent).length !== 1) throw new Error("invalid_otlp_parent");
      const text = parent.stringValue ?? parent.string_value;
      if (typeof text !== "string") throw new Error("invalid_otlp_parent");
      validateEvalOtlpParent(text, projectId, expectedParent);
    }
    if (Object.hasOwn(row, "braintrust.parent")) {
      if (typeof row["braintrust.parent"] !== "string") throw new Error("invalid_otlp_parent");
      validateEvalOtlpParent(row["braintrust.parent"], projectId, expectedParent);
    }
    Object.values(row).forEach(item => inspect(item, depth + 1));
  };
  inspect(decoded, 0);
  const canonical = Buffer.from(JSON.stringify(decoded));
  const sizing = expandedEvalOtlpSize(decoded as Record<string, unknown>, signal);
  return { body: contentType === "application/json" ? canonical : body, ...sizing };
}

function expandedEvalOtlpSize(decoded: Record<string, unknown>, signal: EvalOtlpSignal) {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_otlp_record");
    return value as Record<string, unknown>;
  };
  const take = (row: Record<string, unknown>, camel: string, snake = camel) => {
    if (camel !== snake && Object.hasOwn(row, camel) && Object.hasOwn(row, snake)) throw new Error("ambiguous_otlp_collection");
    const value = Object.hasOwn(row, camel) ? row[camel] : Object.hasOwn(row, snake) ? row[snake] : [];
    if (!Array.isArray(value)) throw new Error("invalid_otlp_collection");
    const rest = Object.fromEntries(Object.entries(row).filter(([key]) => key !== camel && key !== snake));
    return { rows: value, rest };
  };
  const traces = signal === "traces";
  const resources = take(decoded, traces ? "resourceSpans" : "resourceLogs", traces ? "resource_spans" : "resource_logs");
  let recordCount = 0, expandedBytes = bytes(decoded);
  for (const resource of resources.rows) {
    const scopes = take(object(resource), traces ? "scopeSpans" : "scopeLogs", traces ? "scope_spans" : "scope_logs");
    for (const scope of scopes.rows) {
      const records = traces ? take(object(scope), "spans") : take(object(scope), "logRecords", "log_records");
      const envelopeBytes = bytes({ source: resources.rest, resource: scopes.rest, scope: records.rest, record: {} }) - 2;
      for (const record of records.rows) {
        recordCount++;
        expandedBytes += envelopeBytes + bytes(object(record));
      }
    }
  }
  return { recordCount, expandedBytes };
}

export function evalOtlpRejected(body: Buffer, contentType: string, signal: EvalOtlpSignal): number {
  if (!body.length) return 0;
  const decoded = contentType === "application/json" ? JSON.parse(body.toString("utf8"))
    : root.lookupType("Response").decode(body).toJSON();
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid_otlp_response");
  const partial = decoded.partialSuccess;
  if (partial !== undefined && (!partial || typeof partial !== "object" || Array.isArray(partial))) throw new Error("invalid_otlp_response");
  const rejected = partial?.[signal === "traces" ? "rejectedSpans" : "rejectedLogRecords"] ?? partial?.rejected ?? 0;
  if (!/^[0-9]+$/.test(String(rejected)) || !Number.isSafeInteger(Number(rejected))) throw new Error("invalid_otlp_response");
  return Number(rejected);
}

export function evalOtlpResponse(rejected: number, contentType: string, signal: EvalOtlpSignal): Buffer {
  if (contentType === "application/json") return Buffer.from(JSON.stringify(rejected
    ? { partialSuccess: { [signal === "traces" ? "rejectedSpans" : "rejectedLogRecords"]: String(rejected) } } : {}));
  const type = root.lookupType("Response");
  return Buffer.from(type.encode(type.fromObject(rejected ? { partialSuccess: { rejected: String(rejected) } } : {})).finish());
}
