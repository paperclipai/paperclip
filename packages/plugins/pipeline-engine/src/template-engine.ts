import Handlebars from "handlebars";

// Register a helper that JSON-serializes non-primitive values so that
// nested objects and arrays are readable rather than "[object Object]".
Handlebars.registerHelper("helperMissing", function (...args: unknown[]) {
  // helperMissing is called for undefined variables; return empty string.
  return "";
});

// Override the default toString behaviour for objects by wrapping the
// context values before compilation.
function serializeValues(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    // If the array contains plain objects, JSON-serialize it; otherwise
    // let Handlebars join the primitives with commas (default behaviour).
    if (value.some((v) => v !== null && typeof v === "object")) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = serializeValues(v);
    }
    return result;
  }
  return value;
}

export function renderTemplate(template: string, context: Record<string, unknown>): string {
  const serialized = serializeValues(context) as Record<string, unknown>;
  const compiled = Handlebars.compile(template, { noEscape: true });
  return compiled(serialized);
}
