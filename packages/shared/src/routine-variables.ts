import type { RoutineVariable } from "./types/routine.js";

const ROUTINE_VARIABLE_MATCHER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

export function isValidRoutineVariableName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

export function extractRoutineVariableNames(template: string | null | undefined): string[] {
  if (!template) return [];
  const found = new Set<string>();
  for (const match of template.matchAll(ROUTINE_VARIABLE_MATCHER)) {
    const name = match[1];
    if (name && !found.has(name)) {
      found.add(name);
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
  template: string | null | undefined,
  existing: RoutineVariable[] | null | undefined,
): RoutineVariable[] {
  const names = extractRoutineVariableNames(template);
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
