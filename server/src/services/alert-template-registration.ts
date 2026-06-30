import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PII_CONTROL_VERSION,
  PII_REJECTION_PATTERNS,
} from "../security/alert-template-pii-patterns.js";
import {
  AlertTemplate,
  PiiTemplateError,
  TemplateValidationResult,
  TemplateViolation,
  validateAlertTemplate,
} from "../security/alert-template-pii.js";

export const ALERT_TEMPLATE_PII_CONTROL_VERSION = PII_CONTROL_VERSION;
export const POLICY_NAME = "pii_rejection_patterns";
export const ENFORCED_LAYER = "alert_template_engine";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REGISTRATION_RECORD_PATH = path.join(
  __dirname,
  "..",
  "registrations",
  "ram87-p4-kill-plane-registration.json",
);

export interface AlertTemplateRegistrationRecord {
  pii_allowlist_only?: boolean;
  pii_rejection_patterns?: string[];
  [key: string]: unknown;
}

export function loadRegistrationRecord(
  recordPath = REGISTRATION_RECORD_PATH,
): AlertTemplateRegistrationRecord {
  const raw = readFileSync(recordPath, "utf8");
  return JSON.parse(raw);
}

// The canonical pattern ids this control actually enforces. Sourced from the
// shared module, never duplicated.
export function enforcedPatternIds(): string[] {
  return PII_REJECTION_PATTERNS.map((pattern) => pattern.id);
}

// Fail-closed binding between the registration record and the canonical control.
//
// The record declares which PII rejection patterns the dashboard layer expects
// the alert-template engine to enforce. This function refuses to run if:
//   - the record does not opt into allowlist-only mode, or
//   - the record declares no (or an empty) pattern list, or
//   - the record's declared pattern list drifts from what this engine actually
//     enforces (a record that expects MORE than we enforce must never be
//     silently under-enforced; a record that expects LESS signals tampering).
//
// This mirrors RAM-400 getForbiddenFields(): "no policy must never mean no
// enforcement", and "refuse to under-enforce a record that expects a layer we
// do not implement".
export function getEnforcedPatterns(record: AlertTemplateRegistrationRecord): string[] {
  if (record?.pii_allowlist_only !== true) {
    throw new Error(
      "Alert-template PII control: registration record does not declare " +
        "pii_allowlist_only: true (fail-closed: refuse to enforce an allowlist " +
        "control the record never opted into)",
    );
  }

  const declared = record?.pii_rejection_patterns;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(
      "Alert-template PII control: registration record is missing a non-empty " +
        "pii_rejection_patterns list (fail-closed: no policy must never mean no enforcement)",
    );
  }

  const enforced = new Set(enforcedPatternIds());
  const declaredSet = new Set(declared);

  const expectedButNotEnforced = declared.filter((id) => !enforced.has(id));
  if (expectedButNotEnforced.length > 0) {
    throw new Error(
      `Alert-template PII control: registration record expects pattern(s) ` +
        `[${expectedButNotEnforced.join(", ")}] that this engine does not enforce ` +
        `(fail-closed: refuse to under-enforce a record that expects controls we do not implement)`,
    );
  }

  const enforcedButNotDeclared = enforcedPatternIds().filter((id) => !declaredSet.has(id));
  if (enforcedButNotDeclared.length > 0) {
    throw new Error(
      `Alert-template PII control: engine enforces pattern(s) ` +
        `[${enforcedButNotDeclared.join(", ")}] not present in the registration record ` +
        `(fail-closed: declared control list drifted from the canonical engine)`,
    );
  }

  return declared.slice();
}

export interface RegistrationTemplateValidationResult {
  ok: boolean;
  failures: Array<{ id?: string; violations: TemplateViolation[] }>;
  enforcedPatterns: string[];
}

// Validate a batch of templates against the record-bound control. Throws (fail-
// closed) if the record/engine binding is invalid; otherwise returns the set of
// templates that contain a PII violation, for Sec Eng review.
export function validateRegistrationTemplates(
  templates: readonly AlertTemplate[],
  record?: AlertTemplateRegistrationRecord,
): RegistrationTemplateValidationResult {
  const rec = record ?? loadRegistrationRecord();
  const enforcedPatterns = getEnforcedPatterns(rec);

  const failures: Array<{ id?: string; violations: TemplateViolation[] }> = [];
  for (const template of templates) {
    const { ok, violations } = validateAlertTemplate(template);
    if (!ok) {
      failures.push({ id: template.id, violations });
    }
  }

  return { ok: failures.length === 0, failures, enforcedPatterns };
}

// Registration-pipeline entrypoint. The alert-template engine MUST call this at
// template registration time. Throws PiiTemplateError on the first PII violation
// (the error names the matching pattern), after confirming the record/engine
// binding is valid.
export function assertAlertTemplateRegistration(
  template: AlertTemplate,
  record?: AlertTemplateRegistrationRecord,
): true {
  const rec = record ?? loadRegistrationRecord();
  // Fail-closed binding check runs on every registration so a tampered record
  // can never silently disable enforcement.
  getEnforcedPatterns(rec);

  const result: TemplateValidationResult = validateAlertTemplate(template);
  if (!result.ok) {
    throw new PiiTemplateError(result.violations);
  }
  return true;
}

export { PiiTemplateError };
