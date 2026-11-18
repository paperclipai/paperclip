import { z } from "zod";

/**
 * Loose JSON Schema object check shared by plugin manifests and tool catalog
 * validators. Accepts any object with a `type`, `$ref`, or composition keyword
 * (`oneOf`/`anyOf`/`allOf`), and the empty object. Kept in its own module so
 * those validators can import each other without a load-order cycle.
 *
 * @see PLUGIN_SPEC.md §10.1 — Manifest shape
 */
export const jsonSchemaSchema = z.record(z.string(), z.unknown()).refine(
  (val) => {
    // Must have a "type" field if non-empty, or be a valid JSON Schema object
    if (Object.keys(val).length === 0) return true;
    return typeof val.type === "string" || val.$ref !== undefined || val.oneOf !== undefined || val.anyOf !== undefined || val.allOf !== undefined;
  },
  { message: "Must be a valid JSON Schema object (requires at least a 'type', '$ref', or composition keyword)" },
);
