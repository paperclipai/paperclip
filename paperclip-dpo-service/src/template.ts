export function renderBodyTemplate<T>(template: T, vars: { prompt: string }): T {
  if (typeof template === "string") {
    return template.replaceAll("{{prompt}}", vars.prompt) as unknown as T;
  }
  if (Array.isArray(template)) {
    return template.map((v) => renderBodyTemplate(v, vars)) as unknown as T;
  }
  if (template !== null && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template)) {
      out[k] = renderBodyTemplate(v, vars);
    }
    return out as unknown as T;
  }
  return template;
}

export function extractByPath(obj: unknown, path: string): string | undefined {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(p);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  if (cur === undefined) return undefined;
  if (typeof cur !== "string") {
    throw new Error(`value at path "${path}" is not a string`);
  }
  return cur;
}
