import type { ZodError } from "zod";
import { brandKitTokensSchema, type BrandKitDocument } from "./schema.js";
import { parseYaml } from "./yaml.js";

export interface BrandKitValidationError {
  // Dotted path into the token tree, e.g. "colors.primary" ("" for the root).
  path: string;
  message: string;
  code: string;
}

export type BrandKitParseResult =
  | { ok: true; document: BrandKitDocument }
  | { ok: false; errors: BrandKitValidationError[] };

interface FrontmatterSplit {
  frontmatter: string;
  body: string;
}

// Split a DESIGN.md into its YAML frontmatter block and prose body. Returns null
// when the document does not open with a `---` fence.
function splitFrontmatter(raw: string): FrontmatterSplit | null {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;

  // First closing fence after the opening one (a line that is exactly `---`).
  const closing = normalized.indexOf("\n---", 3);
  if (closing < 0) return null;
  const afterFence = closing + 4;
  // The closing fence must be its own line.
  if (afterFence < normalized.length && normalized[afterFence] !== "\n") return null;

  return {
    frontmatter: normalized.slice(4, closing),
    body: normalized.slice(afterFence).replace(/^\n+/, "").trimEnd(),
  };
}

function zodErrorsToValidationErrors(error: ZodError): BrandKitValidationError[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Parse and validate a DESIGN.md brand-kit artifact.
 *
 * Returns either the structured document (canonical tokens + prose body) or a
 * list of structured validation errors with dotted paths into the token tree.
 */
export function parseDesignMd(raw: string): BrandKitParseResult {
  const split = splitFrontmatter(raw);
  if (!split) {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: "DESIGN.md must begin with a YAML frontmatter block delimited by '---' fences",
          code: "missing_frontmatter",
        },
      ],
    };
  }

  let parsedFrontmatter: unknown;
  try {
    parsedFrontmatter = parseYaml(split.frontmatter);
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: `Failed to parse YAML frontmatter: ${(err as Error).message}`,
          code: "invalid_yaml",
        },
      ],
    };
  }

  if (typeof parsedFrontmatter !== "object" || parsedFrontmatter === null || Array.isArray(parsedFrontmatter)) {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: "Frontmatter must be a YAML mapping of token categories",
          code: "invalid_frontmatter_shape",
        },
      ],
    };
  }

  const result = brandKitTokensSchema.safeParse(parsedFrontmatter);
  if (!result.success) {
    return { ok: false, errors: zodErrorsToValidationErrors(result.error) };
  }

  return { ok: true, document: { tokens: result.data, body: split.body } };
}
