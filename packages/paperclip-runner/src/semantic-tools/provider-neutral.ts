import { PHASE7_SEMANTIC_TOOL_CATALOG } from "./catalog.js";
import type {
  Phase7SemanticToolDefinition,
  Phase7SemanticToolDescriptor,
} from "./types.js";

export type Phase7SemanticBindingKind = "fake" | "live_codex";

export interface Phase7ProviderNeutralSemanticBinding {
  readonly schema: "paperclip.semantic-binding.v1";
  readonly bindingKind: Phase7SemanticBindingKind;
  readonly contracts: readonly Phase7SemanticToolDefinition[];
}

/**
 * Converts transport-neutral descriptors into model-provider contracts. The
 * binding label is deliberately outside the contract array, so fake and live
 * Codex bindings cannot drift in names, schemas, claims, or redaction metadata.
 */
export function createPhase7ProviderNeutralBinding(
  bindingKind: Phase7SemanticBindingKind,
  descriptors: readonly Phase7SemanticToolDescriptor[] = PHASE7_SEMANTIC_TOOL_CATALOG,
): Phase7ProviderNeutralSemanticBinding {
  return deepFreeze({
    schema: "paperclip.semantic-binding.v1",
    bindingKind,
    contracts: descriptors.map(toDefinition),
  });
}

export function phase7GeneratedSemanticContracts(): readonly Phase7SemanticToolDefinition[] {
  return createPhase7ProviderNeutralBinding("fake").contracts;
}

export function serializePhase7GeneratedSemanticContracts(): string {
  return `${canonicalJson(phase7GeneratedSemanticContracts())}\n`;
}

function toDefinition(descriptor: Phase7SemanticToolDescriptor): Phase7SemanticToolDefinition {
  return {
    name: descriptor.operationId,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    outputSchema: descriptor.outputSchema,
    annotations: {
      semanticContract: descriptor.schema,
      operationId: descriptor.operationId,
      version: descriptor.version,
      exposure: descriptor.exposure,
      requiredClaims: descriptor.requiredClaims,
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
