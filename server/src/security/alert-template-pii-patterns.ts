const SAFE_SHAPE_ORDER = [
  "sha256",
  "uuid",
  "duration",
  "template_var",
  "metric_ref",
] as const;

export type SafeShapeName = (typeof SAFE_SHAPE_ORDER)[number];

export interface AlertTemplateFieldSchema {
  type?: string;
  piiSafeKind?: string;
  enum?: readonly string[];
  const?: unknown;
  maxLength?: number;
}

export type FieldClassification = { safe: boolean; reason: string };

export const PII_CONTROL_VERSION = 1;

export const SAFE_SHAPES: Record<SafeShapeName, RegExp> = {
  sha256: /^[a-f0-9]{64}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  duration: /^\d+(?:ms|s|m|h|d)$/,
  template_var: /^\{\{\s*[a-z0-9_.]+\s*\}\}$/i,
  metric_ref: /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/,
};

export const SAFE_FIELD_KINDS = [
  "enum",
  "const",
  "metric_ref",
  "dashboard_ref",
  "panel_ref",
  "sha256",
  "uuid",
  "slug",
  "bounded_label",
  "numeric",
  "number",
  "boolean",
  "duration",
  "timestamp",
] as const;

const SSN_REGEX =
  /(?:^|[^A-Za-z0-9])((?!000|666|9\d\d)\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4})(?![\dA-Za-z-])/;
const EMAIL_REGEX =
  /(?:^|[^A-Za-z0-9._%+-])([A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)(?![A-Za-z0-9._%+-])/i;
const CC_CANDIDATE_REGEX = /(?:^|[^A-Za-z0-9])((?:\d[ -]?){12,18}\d)(?![A-Za-z0-9])/;

const CC_ISSUERS = [
  { name: "visa", re: /^4\d{12}(?:\d{3})?$/ },
  {
    name: "mastercard",
    re: /^(?:5[1-5]\d{14}|(?:222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)\d{12})$/,
  },
  { name: "amex", re: /^3[47]\d{13}$/ },
  { name: "discover", re: /^(?:6011\d{12}|65\d{14}|64[4-9]\d{13})$/ },
];

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function isCreditCard(rawCandidate: string): boolean {
  const digits = rawCandidate.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 16) return false;
  const issuerMatch = CC_ISSUERS.some((iss) => iss.re.test(digits));
  if (!issuerMatch) return false;
  return luhnValid(digits);
}

export type PiiRejectionPatternKind = "regex" | "detector" | "schema_rule";

export const PII_REJECTION_PATTERNS: ReadonlyArray<{ id: string; kind: PiiRejectionPatternKind }> = [
  { id: "ssn", kind: "regex" },
  { id: "email", kind: "regex" },
  { id: "credit_card", kind: "detector" },
  { id: "freeform_string_unbound", kind: "schema_rule" },
];

export function matchSafeShape(value: string | unknown): SafeShapeName | null {
  const v = String(value).trim();
  for (const name of SAFE_SHAPE_ORDER) {
    const re = SAFE_SHAPES[name];
    if (re.test(v)) return name;
  }
  return null;
}

export function classifyFieldRef(fieldSchema?: AlertTemplateFieldSchema): FieldClassification {
  if (!fieldSchema || typeof fieldSchema !== "object") {
    return { safe: false, reason: "freeform_string_unbound" };
  }
  if (Array.isArray(fieldSchema.enum) && fieldSchema.enum.length > 0) {
    return { safe: true, reason: "enum" };
  }
  if (fieldSchema.const !== undefined) {
    return { safe: true, reason: "const" };
  }
  const kind = fieldSchema.piiSafeKind ?? fieldSchema.type;
  if (typeof kind === "string" && SAFE_FIELD_KINDS.includes(kind as typeof SAFE_FIELD_KINDS[number])) {
    return { safe: true, reason: kind };
  }
  return { safe: false, reason: "freeform_string_unbound" };
}

export function scanLiteral(value: string | unknown): string | null {
  const v = String(value);
  if (matchSafeShape(v)) return null;

  if (SSN_REGEX.test(v)) return "ssn";
  if (EMAIL_REGEX.test(v)) return "email";

  const ccMatch = v.match(CC_CANDIDATE_REGEX);
  if (ccMatch && isCreditCard(ccMatch[1])) return "credit_card";

  return null;
}
