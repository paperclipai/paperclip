/** Live provider projection of the per-action protocol definitions. */
import { PAPERCLIP_PROTOCOL_ACTIONS } from "../protocol-actions/index.js";
import type { CapabilitySemanticOperationId, CapabilitySemanticToolDescriptor } from "./types.js";
const descriptors = PAPERCLIP_PROTOCOL_ACTIONS.filter((action) => action.live !== null)
  .sort((left, right) => left.live!.order - right.live!.order)
  .map((action) => action.live!.descriptor as unknown as CapabilitySemanticToolDescriptor);
export const CAPABILITY_SEMANTIC_TOOL_CATALOG: readonly CapabilitySemanticToolDescriptor[] = Object.freeze(descriptors);
const byId = new Map(descriptors.map((item) => [item.operationId, item]));
export function capabilitySemanticToolDescriptor(operationId: string): CapabilitySemanticToolDescriptor | undefined { return byId.get(operationId as CapabilitySemanticOperationId); }
export function canonicalCapabilitySemanticCatalog(): string { return canonicalJson(CAPABILITY_SEMANTIC_TOOL_CATALOG); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`; }
  return JSON.stringify(value) ?? "null";
}
