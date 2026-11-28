/**
 * Some model hosts convert a tool's input schema before showing it to the
 * model. A root that is not a plain object with named properties (for example
 * a root oneOf, anyOf, allOf or if/then) can arrive as an empty argument list,
 * so the model calls the tool with no arguments at all. Agent-facing tools keep
 * a plain object root; cross-field rules are checked by
 * `toolInputVariantError` instead.
 */
const ROOT_COMBINATORS = [
  "oneOf", "anyOf", "allOf", "not", "if", "then", "else",
  "dependentRequired", "dependentSchemas", "$ref", "$dynamicRef",
] as const;

export function providerToolSchemaShapeIssues(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return ["input schema is not an object"];
  const root = schema as Record<string, unknown>;
  const issues: string[] = [];
  if (root.type !== "object") issues.push("root type is not \"object\"");
  const properties = root.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) issues.push("root has no properties object");
  for (const keyword of ROOT_COMBINATORS) if (Object.hasOwn(root, keyword)) issues.push(`root uses ${keyword}`);
  return issues;
}
