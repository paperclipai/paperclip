import {
  BRAND_KIT_TOKEN_KEY_ORDER,
  type BrandKitDocument,
  type BrandKitTokens,
} from "./schema.js";
import { emitYaml, type YamlValue } from "./yaml.js";

// Reorder the top-level token keys into the canonical order so serialized output
// is stable regardless of how the source was authored. Nested fixed-shape objects
// already come out of the zod parse in schema-definition order; record-style maps
// (color scales, spacing, breakpoints, …) intentionally preserve author order.
function orderTokens(tokens: BrandKitTokens): Record<string, YamlValue> {
  const source = tokens as Record<string, unknown>;
  const ordered: Record<string, YamlValue> = {};
  for (const key of BRAND_KIT_TOKEN_KEY_ORDER) {
    const value = source[key];
    if (value !== undefined) ordered[key] = value as YamlValue;
  }
  return ordered;
}

/**
 * Serialize a brand-kit document back into canonical DESIGN.md text.
 *
 * `serializeDesignMd(parseDesignMd(x).document)` is idempotent: re-parsing the
 * output yields an equivalent token model, and re-serializing yields identical
 * bytes. This is the round-trip guarantee the artifact format depends on.
 */
export function serializeDesignMd(document: BrandKitDocument): string {
  const yaml = emitYaml(orderTokens(document.tokens));
  const fence = `---\n${yaml}\n---`;
  const body = document.body.trim();
  return body.length > 0 ? `${fence}\n\n${body}\n` : `${fence}\n`;
}
