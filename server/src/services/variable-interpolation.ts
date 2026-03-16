/**
 * Variable interpolation service for workflow execution
 * Handles {{ variable }} template syntax with dot notation for nested properties
 */

/**
 * Interpolate a string with variables from context
 * Supports {{ variable }} and {{ object.property.nested }} syntax
 */
export function interpolateString(
  template: string,
  context: Record<string, unknown>
): string {
  if (typeof template !== "string") {
    return String(template);
  }

  return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const trimmedPath = path.trim();
    const value = getNestedValue(context, trimmedPath);
    return value !== undefined ? String(value) : match;
  });
}

/**
 * Get a nested value from an object using dot notation
 * e.g., "user.profile.name" -> context.user.profile.name
 */
function getNestedValue(
  obj: Record<string, unknown>,
  path: string
): unknown {
  const keys = path.split(".");
  let current: unknown = obj;

  for (const key of keys) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Recursively interpolate all string values in an object
 */
export function interpolateObject(
  obj: unknown,
  context: Record<string, unknown>
): unknown {
  if (typeof obj === "string") {
    return interpolateString(obj, context);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => interpolateObject(item, context));
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateObject(value, context);
    }
    return result;
  }

  return obj;
}

/**
 * Build execution context from workflow variables and step results
 */
export function buildExecutionContext(
  variables: Record<string, unknown>,
  stepResults: Map<string, unknown>
): Record<string, unknown> {
  const context: Record<string, unknown> = { ...variables };

  // Add step results with "steps" namespace
  const stepsObj: Record<string, unknown> = {};
  for (const [key, value] of stepResults) {
    stepsObj[key] = value;
  }
  context.steps = stepsObj;

  return context;
}

/**
 * Validate that all required variables are available in context
 */
export function validateVariablesAvailable(
  template: string,
  context: Record<string, unknown>
): string[] {
  const missing: string[] = [];
  const variables = template.match(/\{\{([^}]+)\}\}/g) || [];

  for (const variable of variables) {
    const path = variable.slice(2, -2).trim();
    if (getNestedValue(context, path) === undefined) {
      missing.push(path);
    }
  }

  return missing;
}
