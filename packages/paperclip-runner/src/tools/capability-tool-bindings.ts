import type {
  CapabilityJsonSchema,
  CapabilitySemanticToolDescriptor,
  CapabilityVisibleToolSet,
} from "./capability-semantic-tool-types.js";

export interface CapabilityToolBinding<TDefinition> {
  readonly kind: "fake_agent" | "codex";
  bind(visibleTools: CapabilityVisibleToolSet): readonly TDefinition[];
  operationId(definition: TDefinition): string;
}

export interface CapabilityFakeAgentToolDefinition {
  operationId: string;
  description: string;
  inputSchema: CapabilityJsonSchema;
  outputSchema: CapabilityJsonSchema;
}

export interface CapabilityCodexToolDefinition {
  type: "function";
  name: string;
  description: string;
  strict: true;
  parameters: CapabilityJsonSchema;
}

export class CapabilityFakeAgentToolBinding implements CapabilityToolBinding<CapabilityFakeAgentToolDefinition> {
  readonly kind = "fake_agent" as const;

  bind(visibleTools: CapabilityVisibleToolSet): readonly CapabilityFakeAgentToolDefinition[] {
    return freezeDefinitions(visibleTools.tools.map((tool) => ({
      operationId: tool.operationId,
      description: tool.description,
      inputSchema: structuredClone(tool.inputSchema),
      outputSchema: structuredClone(tool.outputSchema),
    })));
  }

  operationId(definition: CapabilityFakeAgentToolDefinition): string {
    return definition.operationId;
  }
}

export class CapabilityCodexToolBinding implements CapabilityToolBinding<CapabilityCodexToolDefinition> {
  readonly kind = "codex" as const;

  bind(visibleTools: CapabilityVisibleToolSet): readonly CapabilityCodexToolDefinition[] {
    return freezeDefinitions(visibleTools.tools.map(toCodexDefinition));
  }

  operationId(definition: CapabilityCodexToolDefinition): string {
    return definition.name;
  }
}

function toCodexDefinition(tool: CapabilitySemanticToolDescriptor): CapabilityCodexToolDefinition {
  return {
    type: "function",
    name: tool.operationId,
    description: tool.description,
    strict: true,
    parameters: structuredClone(tool.inputSchema),
  };
}

function freezeDefinitions<T>(definitions: T[]): readonly T[] {
  for (const definition of definitions) deepFreeze(definition);
  return Object.freeze(definitions);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
