import { z } from "zod";

// ---------------------------------------------------------------------------
// SEC-LLM-001: Input sanitization
// ---------------------------------------------------------------------------

const MAX_AI_INPUT_LENGTH = 2000;

/** Patterns that indicate a prompt injection attempt. Case-insensitive. */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+previous/gi,
  /ignore\s+all/gi,
  /system\s*:/gi,
  /you\s+are\s+now/gi,
  /forget\s+your\s+instructions/gi,
];

/**
 * Sanitize a user-supplied string before interpolating it into an LLM prompt.
 *
 * 1. Enforces a hard max-length of 2000 characters (truncates, does not throw).
 * 2. Strips known prompt-injection patterns.
 *
 * Returns the sanitized string, or throws if the value is not a string.
 */
export function sanitizeAiInput(value: unknown, fieldName = "input"): string {
  if (typeof value !== "string") {
    throw new TypeError(`AI input field "${fieldName}" must be a string`);
  }

  // 1. Enforce max length
  let sanitized = value.slice(0, MAX_AI_INPUT_LENGTH);

  // 2. Strip injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[removed]");
  }

  return sanitized;
}

// ---------------------------------------------------------------------------
// SEC-LLM-002: Output validation schemas
// ---------------------------------------------------------------------------

/** Strips prototype-poisoning keys from a parsed object. */
function stripDangerousKeys<T extends object>(obj: T): T {
  const dangerous = new Set(["__proto__", "constructor", "prototype"]);
  for (const key of Object.keys(obj)) {
    if (dangerous.has(key)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (obj as Record<string, unknown>)[key];
    }
  }
  return obj;
}

// -- Playbook schema ---------------------------------------------------------

const playbookStepSchema = z.object({
  stepOrder: z.number().int().min(1),
  title: z.string().min(1).max(200),
  instructions: z.string().min(1).max(2000),
  assigneeRole: z.string().min(1).max(100),
  dependsOn: z.array(z.number().int().min(0)).default([]),
  requiresApproval: z.boolean().default(false),
});

export const generatedPlaybookSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(500),
  body: z.string().min(1).max(5000),
  category: z.enum([
    "onboarding",
    "security",
    "engineering",
    "operations",
    "marketing",
    "custom",
  ]),
  steps: z.array(playbookStepSchema).min(1).max(20),
});

export type GeneratedPlaybook = z.infer<typeof generatedPlaybookSchema>;

/**
 * Validate and strip unexpected fields from a raw LLM-generated playbook object.
 * Throws a ZodError if the structure is invalid.
 */
export function validatePlaybookOutput(raw: unknown): GeneratedPlaybook {
  if (raw !== null && typeof raw === "object") {
    stripDangerousKeys(raw as object);
  }
  return generatedPlaybookSchema.parse(raw);
}

// -- Goal breakdown schema ---------------------------------------------------

const prioritySchema = z.enum(["high", "medium", "low"]);

const generatedIssueSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  priority: prioritySchema,
  assigneeRole: z.string().min(1).max(100),
  order: z.number().int().min(1),
});

export const goalBreakdownResultSchema = z.object({
  issues: z.array(generatedIssueSchema).min(1).max(20),
});

export type GoalBreakdownResult = z.infer<typeof goalBreakdownResultSchema>;

/**
 * Validate and strip unexpected fields from a raw LLM-generated goal breakdown.
 * Throws a ZodError if the structure is invalid.
 */
export function validateGoalBreakdownOutput(raw: unknown): GoalBreakdownResult {
  if (raw !== null && typeof raw === "object") {
    stripDangerousKeys(raw as object);
  }
  return goalBreakdownResultSchema.parse(raw);
}
