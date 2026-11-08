import { t } from "@/i18n";
export interface ConfigurationStep { label: string; apply: () => Promise<unknown> }
export type AddConfigurationStep = (label: string, apply: ConfigurationStep["apply"]) => void;

export function unique(values: string[], field: string) {
  if (new Set(values).size !== values.length) throw new Error(t("display:config_29a3ba6e1384", { value0: field }));
}

export function requireItem<T>(items: readonly T[], matches: (item: T) => boolean, label: string): T {
  const item = items.find(matches);
  if (!item) throw new Error(t("display:config_ecc7493e208b", { value0: label }));
  return item;
}

export function requireExplicitFields(before: object, after: object, path: string) {
  for (const [key, value] of Object.entries(before)) {
    if (value !== undefined && !Object.hasOwn(after, key)) throw new Error(t("display:config_f15d609be438", { value0: path, value1: key }));
  }
}
