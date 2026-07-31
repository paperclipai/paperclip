import type { RoutineVariable } from "./types/routine.js";

// Tolerate markdown-escaped underscores (`\_`) inside placeholders. WYSIWYG markdown
// editors (e.g. MDXEditor) serialize `_` between word chars as `\_` to prevent
// reparse-as-emphasis, so a user-typed `{{pr_url}}` is stored as `{{pr\_url}}`.
const ROUTINE_VARIABLE_MATCHER = /\{\{\s*([A-Za-z](?:\\_|[A-Za-z0-9_])*)\s*\}\}/g;

function unescapeRoutineVariableName(raw: string): string {
  return raw.replace(/\\_/g, "_");
}

type RoutineTemplateInput = string | null | undefined | Array<string | null | undefined>;

/**
 * Built-in variable names that are automatically available in routine templates
 * without needing to be defined in the routine's variables list.
 */
export const BUILTIN_ROUTINE_VARIABLE_NAMES = new Set(["date", "timestamp"]);

export function isBuiltinRoutineVariable(name: string): boolean {
  return BUILTIN_ROUTINE_VARIABLE_NAMES.has(name);
}

const HUMAN_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "UTC",
  timeZoneName: "short",
});

/**
 * Returns current values for all built-in routine variables.
 * `date` expands to the current date in YYYY-MM-DD format (UTC).
 * `timestamp` expands to a human-readable date and time (e.g. "April 28, 2026 at 12:17 PM UTC").
 */
export function getBuiltinRoutineVariableValues(): Record<string, string> {
  const now = new Date();
  return {
    date: now.toISOString().slice(0, 10),
    timestamp: HUMAN_TIMESTAMP_FORMATTER.format(now),
  };
}

export function isValidRoutineVariableName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

export function isRoutineDateVariableName(name: string): boolean {
  return isValidRoutineVariableName(name) && name.length > "Date".length && name.endsWith("Date");
}

export function isValidRoutineDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1]!;
  return day >= 1 && day <= daysInMonth;
}

function normalizeRoutineTemplateInput(input: RoutineTemplateInput): string[] {
  const templates = Array.isArray(input) ? input : [input];
  return templates.filter((template): template is string => typeof template === "string" && template.length > 0);
}

export function extractRoutineVariableNames(template: RoutineTemplateInput): string[] {
  const found = new Set<string>();
  for (const source of normalizeRoutineTemplateInput(template)) {
    for (const match of source.matchAll(ROUTINE_VARIABLE_MATCHER)) {
      const name = match[1] ? unescapeRoutineVariableName(match[1]) : "";
      if (name && !found.has(name)) {
        found.add(name);
      }
    }
  }
  return [...found];
}

function defaultRoutineVariable(name: string): RoutineVariable {
  return {
    name,
    label: null,
    type: isRoutineDateVariableName(name) ? "date" : "text",
    defaultValue: null,
    required: true,
    options: [],
  };
}

export function syncRoutineVariablesWithTemplate(
  template: RoutineTemplateInput,
  existing: RoutineVariable[] | null | undefined,
): RoutineVariable[] {
  const names = extractRoutineVariableNames(template).filter((name) => !isBuiltinRoutineVariable(name));
  const existingByName = new Map((existing ?? []).map((variable) => [variable.name, variable]));
  return names.map((name) => existingByName.get(name) ?? defaultRoutineVariable(name));
}

export function stringifyRoutineVariableValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function interpolateRoutineTemplate(
  template: string | null | undefined,
  values: Record<string, unknown> | null | undefined,
): string | null {
  if (template == null) return null;
  if (!values || Object.keys(values).length === 0) return template;
  return template.replace(ROUTINE_VARIABLE_MATCHER, (match, rawName: string) => {
    const name = unescapeRoutineVariableName(rawName);
    if (!(name in values)) return match;
    return stringifyRoutineVariableValue(values[name]);
  });
}
