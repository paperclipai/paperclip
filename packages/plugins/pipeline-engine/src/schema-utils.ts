export interface JsonSchema {
  type?: string;
  properties?: Record<string, { type?: string; enum?: string[] }>;
  [key: string]: unknown;
}

export function getDecisionEnumValues(schema: JsonSchema): string[] {
  const decision = schema.properties?.decision;
  if (!decision || !decision.enum) return [];
  return decision.enum;
}
