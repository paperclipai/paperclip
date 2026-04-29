import type { RoutineVariable } from "./types/routine.js";

const ROUTINE_VARIABLE_MATCHER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
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

function normalizeRoutineTemplateInput(input: RoutineTemplateInput): string[] {
  const templates = Array.isArray(input) ? input : [input];
  return templates.filter((template): template is string => typeof template === "string" && template.length > 0);
}

export function extractRoutineVariableNames(template: RoutineTemplateInput): string[] {
  const found = new Set<string>();
  for (const source of normalizeRoutineTemplateInput(template)) {
    for (const match of source.matchAll(ROUTINE_VARIABLE_MATCHER)) {
      const name = match[1];
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
    type: "text",
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
    if (!(rawName in values)) return match;
    return stringifyRoutineVariableValue(values[rawName]);
  });
}
