import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "./catalog.js";
import type {
  CapabilitySemanticToolDefinition,
  CapabilitySemanticToolDescriptor,
} from "./types.js";

export type CapabilitySemanticBindingKind = "fake" | "live_codex";

export interface CapabilityProviderNeutralSemanticBinding {
  readonly schema: "paperclip.semantic-binding.v1";
  readonly bindingKind: CapabilitySemanticBindingKind;
  readonly contracts: readonly CapabilitySemanticToolDefinition[];
}

/**
 * Converts transport-neutral descriptors into model-provider contracts. The
 * binding label is deliberately outside the contract array, so fake and live
 * Codex bindings cannot drift in names, schemas, claims, or redaction metadata.
 */
export function createCapabilityProviderNeutralBinding(
  bindingKind: CapabilitySemanticBindingKind,
  descriptors: readonly CapabilitySemanticToolDescriptor[] = CAPABILITY_SEMANTIC_TOOL_CATALOG,
): CapabilityProviderNeutralSemanticBinding {
  return deepFreeze({
    schema: "paperclip.semantic-binding.v1",
    bindingKind,
    contracts: descriptors.map(toDefinition),
  });
}

export function capabilityGeneratedSemanticContracts(): readonly CapabilitySemanticToolDefinition[] {
  return createCapabilityProviderNeutralBinding("fake").contracts;
}

export function serializeCapabilityGeneratedSemanticContracts(): string {
  return `${canonicalJson(capabilityGeneratedSemanticContracts())}\n`;
}

function toDefinition(descriptor: CapabilitySemanticToolDescriptor): CapabilitySemanticToolDefinition {
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
