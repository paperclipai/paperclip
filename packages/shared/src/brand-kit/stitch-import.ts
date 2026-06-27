import { brandKitTokensSchema, type BrandKitDocument } from "./schema.js";
import type { BrandKitValidationError } from "./parse.js";
import { parseYaml, type YamlValue } from "./yaml.js";

// Stitch→native import shim (NEO-138 §A0.1 / NEO-267).
//
// Stitch (Google) emits a DESIGN.md whose token vocabulary follows Material
// Design 3 (MD3): color roles like `primary`/`secondary`/`tertiary`/`error`,
// a `displayLarge`…`labelSmall` type scale, and `shape` corner sizes. This shim
// maps that vocabulary into the Neoreef-native vocabulary so an MD3 artifact
// "round-trips into native vocab". Native role names are passed through
// unchanged, so the shim is also a no-op on already-native input.

export interface BrandKitImportResult {
  ok: boolean;
  document?: BrandKitDocument;
  errors?: BrandKitValidationError[];
  // Non-fatal notes: keys that could not be mapped and were dropped or kept
  // verbatim. Surfaced so importers can flag lossy conversions.
  warnings: string[];
}

const MD3_TYPE_SCALE_MAP: Record<string, string> = {
  displayLarge: "display",
  displayMedium: "displayMedium",
  displaySmall: "displaySmall",
  headlineLarge: "h1",
  headlineMedium: "h2",
  headlineSmall: "h3",
  titleLarge: "h4",
  titleMedium: "h5",
  titleSmall: "h6",
  bodyLarge: "body",
  bodyMedium: "bodyMedium",
  bodySmall: "bodySmall",
  labelLarge: "label",
  labelMedium: "caption",
  labelSmall: "overline",
};

const MD3_TYPE_PROP_MAP: Record<string, string> = {
  fontFamily: "family",
  family: "family",
  fontSize: "size",
  size: "size",
  fontWeight: "weight",
  weight: "weight",
  lineHeight: "lineHeight",
  letterSpacing: "letterSpacing",
  tracking: "letterSpacing",
};

const MD3_SEMANTIC_MAP: Record<string, string> = {
  error: "error",
  danger: "error",
  success: "success",
  warning: "warning",
  info: "info",
};

const MD3_SHAPE_MAP: Record<string, string> = {
  none: "none",
  extraSmall: "xs",
  small: "sm",
  medium: "md",
  large: "lg",
  extraLarge: "xl",
  full: "full",
};

function isRecord(value: YamlValue | undefined): value is Record<string, YamlValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asScalarString(value: YamlValue): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function mapColors(
  input: Record<string, YamlValue>,
  warnings: string[],
): Record<string, YamlValue> {
  const colors: Record<string, YamlValue> = {};
  const semantic: Record<string, YamlValue> = {};
  const neutralFallbacks: YamlValue[] = [];

  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case "primary":
        colors.primary = value;
        break;
      case "secondary":
        colors.secondary = value;
        break;
      case "accent":
      case "tertiary":
        if (colors.accent === undefined) colors.accent = value;
        break;
      case "neutral":
        colors.neutral = value;
        break;
      case "neutralVariant":
      case "surface":
      case "background":
        neutralFallbacks.push(value);
        break;
      case "semantic":
        if (isRecord(value)) Object.assign(semantic, value);
        break;
      default: {
        const semanticRole = MD3_SEMANTIC_MAP[key];
        if (semanticRole) {
          semantic[semanticRole] = value;
        } else {
          warnings.push(`Unmapped color role "${key}" was dropped during Stitch import`);
        }
      }
    }
  }

  if (colors.neutral === undefined && neutralFallbacks.length > 0) {
    colors.neutral = neutralFallbacks[0]!;
  }
  if (Object.keys(semantic).length > 0) colors.semantic = semantic;
  return colors;
}

function mapTypography(
  input: Record<string, YamlValue>,
  warnings: string[],
): Record<string, YamlValue> {
  const scale: Record<string, YamlValue> = {};
  const out: Record<string, YamlValue> = {};

  // Optional shared families block carries through untouched.
  if (isRecord(input.families)) out.families = input.families;

  const scaleSource = isRecord(input.scale) ? input.scale : input;
  for (const [key, value] of Object.entries(scaleSource)) {
    if (key === "families" || key === "scale") continue;
    if (!isRecord(value)) continue;

    const nativeName = MD3_TYPE_SCALE_MAP[key] ?? key;
    if (!MD3_TYPE_SCALE_MAP[key]) {
      warnings.push(`Type scale "${key}" had no MD3 mapping and was kept verbatim`);
    }

    const style: Record<string, YamlValue> = {};
    for (const [prop, propValue] of Object.entries(value)) {
      const nativeProp = MD3_TYPE_PROP_MAP[prop];
      if (!nativeProp) {
        warnings.push(`Type property "${prop}" on "${key}" was dropped during Stitch import`);
        continue;
      }
      // Native string-typed fields; coerce numeric MD3 values (e.g. sp sizes).
      if (nativeProp === "weight") {
        style.weight = propValue;
      } else {
        const scalar = asScalarString(propValue);
        if (scalar !== undefined) style[nativeProp] = scalar;
      }
    }
    scale[nativeName] = style;
  }

  out.scale = scale;
  return out;
}

function mapShape(input: Record<string, YamlValue>, warnings: string[]): Record<string, YamlValue> {
  const source = isRecord(input.corner) ? input.corner : input;
  const rounded: Record<string, YamlValue> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "corner") continue;
    const nativeName = MD3_SHAPE_MAP[key] ?? key;
    if (!MD3_SHAPE_MAP[key]) {
      warnings.push(`Shape size "${key}" had no MD3 mapping and was kept verbatim`);
    }
    const scalar = asScalarString(value);
    if (scalar !== undefined) rounded[nativeName] = scalar;
  }
  return rounded;
}

/**
 * Import a Stitch/MD3-flavored DESIGN.md (or already-native one) into the
 * canonical native token model. Returns the validated native document plus any
 * non-fatal conversion warnings, or structured errors if the mapped result fails
 * native validation.
 */
export function importStitchDesign(raw: string): BrandKitImportResult {
  const warnings: string[] = [];

  const normalized = raw.replace(/\r\n/g, "\n");
  let frontmatterRaw = normalized;
  let body = "";
  if (normalized.startsWith("---\n")) {
    const closing = normalized.indexOf("\n---", 3);
    if (closing >= 0) {
      frontmatterRaw = normalized.slice(4, closing);
      body = normalized.slice(closing + 4).replace(/^\n+/, "").trimEnd();
    }
  }

  const parsed = parseYaml(frontmatterRaw);
  if (!isRecord(parsed)) {
    return {
      ok: false,
      warnings,
      errors: [{ path: "", message: "Stitch frontmatter must be a YAML mapping", code: "invalid_frontmatter_shape" }],
    };
  }

  const native: Record<string, YamlValue> = {};

  const name = asScalarString(parsed.name ?? parsed.title ?? parsed.brand);
  native.name = name ?? "Imported Brand Kit";
  if (!name) warnings.push("No name found in Stitch source; defaulted to \"Imported Brand Kit\"");

  const colorsInput = isRecord(parsed.colors) ? parsed.colors : isRecord(parsed.color) ? parsed.color : undefined;
  if (colorsInput) native.colors = mapColors(colorsInput, warnings);

  const typographyInput = isRecord(parsed.typography)
    ? parsed.typography
    : isRecord(parsed.type)
      ? parsed.type
      : undefined;
  if (typographyInput) native.typography = mapTypography(typographyInput, warnings);

  const shapeInput = isRecord(parsed.shape) ? parsed.shape : isRecord(parsed.rounded) ? parsed.rounded : undefined;
  if (shapeInput) {
    const rounded = mapShape(shapeInput, warnings);
    if (Object.keys(rounded).length > 0) native.rounded = rounded;
  }

  // Categories that share the native vocabulary carry through untouched.
  for (const passthrough of ["spacing", "elevation", "motion", "breakpoints", "zIndex", "imagery", "narrative", "narrativeRef", "voice", "assets"] as const) {
    if (parsed[passthrough] !== undefined) native[passthrough] = parsed[passthrough]!;
  }

  const result = brandKitTokensSchema.safeParse(native);
  if (!result.success) {
    return {
      ok: false,
      warnings,
      errors: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })),
    };
  }

  return { ok: true, warnings, document: { tokens: result.data, body } };
}
