import {
  AlertTemplateFieldSchema,
  PII_CONTROL_VERSION,
  SAFE_SHAPES,
  classifyFieldRef,
  scanLiteral,
} from "./alert-template-pii-patterns.js";

const TEMPLATE_VAR_GLOBAL = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;

function extractFieldRefs(text: string) {
  const refs: string[] = [];
  let match: RegExpExecArray | null;
  TEMPLATE_VAR_GLOBAL.lastIndex = 0;
  while ((match = TEMPLATE_VAR_GLOBAL.exec(text)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

function stripFieldRefs(text: string) {
  return text.replace(TEMPLATE_VAR_GLOBAL, " ");
}

export type AlertTemplate = {
  id?: string;
  subject?: string | null;
  body?: string | null;
  labels?: Record<string, string | null>;
  fields?: Record<string, AlertTemplateFieldSchema>;
};

export type TemplateViolation = {
  surface: string;
  pattern: string;
  detail?: string;
};

export type TemplateValidationResult = {
  ok: boolean;
  violations: TemplateViolation[];
};

export class PiiTemplateError extends Error {
  readonly violations: TemplateViolation[];
  readonly controlVersion: number;

  constructor(violations: TemplateViolation[]) {
    const first = violations[0];
    super(
      `Alert template rejected: PII control violation '${first.pattern}' in ${first.surface}` +
        (first.detail ? ` (${first.detail})` : ""),
    );
    this.name = "PiiTemplateError";
    this.violations = violations;
    this.controlVersion = PII_CONTROL_VERSION;
  }
}

function scanSurface(
  surface: string,
  value: string,
  fields: Record<string, AlertTemplateFieldSchema>,
  violations: TemplateViolation[],
) {
  const literal = stripFieldRefs(value).trim();
  if (literal.length > 0) {
    const hit = scanLiteral(literal);
    if (hit) {
      violations.push({ surface, pattern: hit, detail: "literal text" });
    }
  }

  for (const ref of extractFieldRefs(value)) {
    const schema = fields[ref];
    const { safe, reason } = classifyFieldRef(schema);
    if (!safe) {
      violations.push({
        surface,
        pattern: "freeform_string_unbound",
        detail: `field '${ref}' (${schema ? "unconstrained string" : "unknown field"})`,
      });
    } else if (reason && !(reason in SAFE_SHAPES) && !schema?.enum && schema?.const === undefined) {
      // safe by typed kind — accepted without recording.
    }
  }
}

export function validateAlertTemplate(template: AlertTemplate): TemplateValidationResult {
  const violations: TemplateViolation[] = [];
  const fields = template.fields ?? {};

  if (template.subject != null) scanSurface("subject", template.subject, fields, violations);
  if (template.body != null) scanSurface("body", template.body, fields, violations);

  const labels = template.labels ?? {};
  for (const [key, value] of Object.entries(labels)) {
    if (value != null) {
      scanSurface(`label:${key}`, value, fields, violations);
    }
  }

  return { ok: violations.length === 0, violations };
}

export function assertAlertTemplate(template: AlertTemplate) {
  const { ok, violations } = validateAlertTemplate(template);
  if (!ok) throw new PiiTemplateError(violations);
  return true;
}

export function revalidateExistingTemplates(templates: readonly AlertTemplate[]) {
  const failures: Array<{ id?: string; violations: TemplateViolation[] }> = [];
  for (const template of templates) {
    const { ok, violations } = validateAlertTemplate(template);
    if (!ok) {
      failures.push({ id: template.id, violations });
    }
  }
  return failures;
}
