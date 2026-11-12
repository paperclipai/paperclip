import type { ValidateFunction } from "ajv/dist/2020.js";

/** Return schema-owned recovery guidance without changing validation or dispatch. */
export function toolInputError(validator: ValidateFunction | undefined): string {
  const errors = validator?.errors ?? [];
  const detail = errors.map(error => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
  const schema = validator?.schema;
  const properties = typeof schema === "object" && schema !== null ? schema.properties : undefined;
  const guidance = new Set<string>();
  for (const error of errors) {
    // Only direct required properties are supported. Nested schemas and refs
    // need their own resolution; do not attach guidance from a different scope.
    if (error.keyword !== "required" || error.instancePath !== "") continue;
    const key = error.params.missingProperty;
    if (typeof key !== "string" || !properties || !Object.hasOwn(properties, key)) continue;
    const description = properties[key]?.description;
    if (typeof description === "string" && description.trim()) guidance.add(description.slice(0, 1000));
    if (guidance.size === 3) break;
  }
  return `Invalid tool input${detail ? `: ${detail}` : "."}${guidance.size ? ` ${[...guidance].join(" ")}` : ""}`;
}
