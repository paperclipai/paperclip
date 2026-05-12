export interface JsonSchema {
  type?: string;
  properties?: Record<string, { type?: string; enum?: string[]; items?: { type?: string; enum?: string[] } }>;
  [key: string]: unknown;
}

export function getDecisionEnumValues(schema: JsonSchema): string[] {
  const decision = schema.properties?.decision;
  if (!decision || !decision.enum) return [];
  return decision.enum;
}

export function getArrayFieldValues(schema: JsonSchema, fieldName: string): string[] {
  const field = schema.properties?.[fieldName];
  if (!field || field.type !== "array") return [];
  return field.items?.enum ?? [];
}
