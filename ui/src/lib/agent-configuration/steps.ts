export interface ConfigurationStep { label: string; apply: () => Promise<unknown> }
export type AddConfigurationStep = (label: string, apply: ConfigurationStep["apply"]) => void;

export function unique(values: string[], field: string) {
  if (new Set(values).size !== values.length) throw new Error(`${field} contains duplicate entries.`);
}

export function requireItem<T>(items: readonly T[], matches: (item: T) => boolean, label: string): T {
  const item = items.find(matches);
  if (!item) throw new Error(`${label} is not in this agent’s saved configuration. Reload before editing it.`);
  return item;
}

export function requireExplicitFields(before: object, after: object, path: string) {
  for (const [key, value] of Object.entries(before)) {
    if (value !== undefined && !Object.hasOwn(after, key)) throw new Error(`Keep ${path}.${key} explicit; use null, false, an empty string, or an empty list to clear it where supported.`);
  }
}
