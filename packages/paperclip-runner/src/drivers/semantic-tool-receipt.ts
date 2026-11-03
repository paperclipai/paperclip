import { createHash } from "node:crypto";

export const SEMANTIC_RECEIPT_SCHEMA = "paperclip.semantic_tool_receipt.v2";
const LEGACY_SEMANTIC_RECEIPT_SCHEMA = "paperclip.semantic_tool_receipt.v1";
export const MAX_SEMANTIC_RECEIPT_BYTES = 2048;
const MAX_NATIVE_BYTES = 256 * 1024;
interface SemanticToolReceiptFields {
  operationId: string;
  callIdentitySha256: string;
  inputSha256: string;
  resultSha256: string;
  /** Transport outcome only: a returned value may explicitly reject a request. */
  outcome: "returned" | "error";
}
export type SemanticToolReceipt = SemanticToolReceiptFields & (
  | { schema: typeof LEGACY_SEMANTIC_RECEIPT_SCHEMA }
  | { schema: typeof SEMANTIC_RECEIPT_SCHEMA; normalizedInputSha256: string | null }
);
export interface SemanticToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** Same canonical JSON used by the bridge's admitted-call fingerprint. */
export function semanticCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(semanticCanonicalJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${semanticCanonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export const semanticInputSha256 = (value: unknown): string => hash(semanticCanonicalJson(value));
export function parseSemanticToolReceipt(value: unknown): SemanticToolReceipt | null {
  if (!object(value)) return null;
  const legacy = value.schema === LEGACY_SEMANTIC_RECEIPT_SCHEMA;
  const keys = legacy ? "callIdentitySha256,inputSha256,operationId,outcome,resultSha256,schema"
    : "callIdentitySha256,inputSha256,normalizedInputSha256,operationId,outcome,resultSha256,schema";
  if (Object.keys(value).sort().join(",") !== keys
    || (!legacy && value.schema !== SEMANTIC_RECEIPT_SCHEMA)
    || typeof value.operationId !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.operationId)
    || ![value.callIdentitySha256, value.inputSha256, value.resultSha256].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))
    || (!legacy && value.normalizedInputSha256 !== null && (typeof value.normalizedInputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.normalizedInputSha256)))
    || (value.outcome !== "returned" && value.outcome !== "error")
    || Buffer.byteLength(JSON.stringify(value)) > MAX_SEMANTIC_RECEIPT_BYTES) return null;
  const fields: SemanticToolReceiptFields = { operationId: value.operationId,
    callIdentitySha256: value.callIdentitySha256 as string, inputSha256: value.inputSha256 as string,
    resultSha256: value.resultSha256 as string, outcome: value.outcome };
  return legacy ? { schema: LEGACY_SEMANTIC_RECEIPT_SCHEMA, ...fields }
    : { schema: SEMANTIC_RECEIPT_SCHEMA, ...fields, normalizedInputSha256: value.normalizedInputSha256 as string | null };
}
function resultDigest(result: SemanticToolResult): string {
  return semanticInputSha256({ content: result.content, isError: result.isError === true });
}
/** Append, never rewrite, the original admitted result encoding and content. */
export function appendSemanticToolReceipt(call: { tool: string; callId: string; arguments: unknown; normalizedInputSha256?: string | null }, result: SemanticToolResult) {
  const receipt = parseSemanticToolReceipt({ schema: SEMANTIC_RECEIPT_SCHEMA, operationId: call.tool,
    callIdentitySha256: hash(call.callId), inputSha256: semanticInputSha256(call.arguments),
    normalizedInputSha256: call.normalizedInputSha256 ?? null,
    resultSha256: resultDigest(result), outcome: result.isError ? "error" : "returned" });
  if (!receipt) throw new Error("Invalid semantic receipt identity");
  return { receipt, result: { ...result, content: [...result.content, { type: "text" as const, text: JSON.stringify(receipt) }] } };
}
/**
 * A native echo is only a candidate. Authority comes from the invocation callback.
 * The 256 KiB bound applies to the WHOLE native rawOutput, including repeated
 * content/detailedContent. Larger results still receive bridge receipts, but
 * intentionally provide no native correlation evidence; never truncate to match.
 */
export function readNativeSemanticReceipt(raw: unknown): SemanticToolReceipt | null {
  try {
    if (!object(raw) || Buffer.byteLength(JSON.stringify(raw)) > MAX_NATIVE_BYTES || !Array.isArray(raw.contents)
      || raw.contents.length < 2 || raw.contents.length > 128) return null;
    const blocks = raw.contents;
    if (!blocks.every(b => object(b) && Object.keys(b).sort().join(",") === "text,type" && b.type === "text" && typeof b.text === "string")) return null;
    const last = blocks.at(-1) as { text: string };
    if (Buffer.byteLength(last.text) > MAX_SEMANTIC_RECEIPT_BYTES) return null;
    const receipt = parseSemanticToolReceipt(JSON.parse(last.text));
    if (!receipt) return null;
    const original = blocks.slice(0, -1) as SemanticToolResult["content"];
    if (original.some(b => { try { return parseSemanticToolReceipt(JSON.parse(b.text)) !== null; } catch { return false; } })) return null;
    return resultDigest({ content: original, isError: receipt.outcome === "error" }) === receipt.resultSha256 ? receipt : null;
  } catch { return null; }
}
export const sameSemanticReceipt = (a: SemanticToolReceipt, b: SemanticToolReceipt): boolean => semanticCanonicalJson(a) === semanticCanonicalJson(b);
