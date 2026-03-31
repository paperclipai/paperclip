import { translateInstant } from "../i18n";

const SEEDED_NAME_TRANSLATION_KEYS: Record<string, string> = {
  CEO: "seededName.ceo",
  CTO: "seededName.cto",
  "Chief Technology Officer": "seededName.cto",
  "首席执行官": "seededName.ceo",
  "首席技术官": "seededName.cto",
};

export function displaySeededName(name: string | null | undefined): string {
  if (!name) return "";
  const translationKey = SEEDED_NAME_TRANSLATION_KEYS[name];
  return translationKey
    ? translateInstant(translationKey, { defaultValue: name })
    : name;
}
