import { en, type DeepPartial, type Translations } from "./en";
import { ptBR } from "./pt-BR";

export type Language = "en" | "pt-BR";

function deepMerge<T extends object>(base: T, override: DeepPartial<T>): T {
  const result = { ...base };
  for (const key in override) {
    const val = override[key as keyof typeof override];
    if (val !== undefined) {
      if (typeof val === "object" && !Array.isArray(val)) {
        result[key as keyof T] = deepMerge(base[key as keyof T] as object, val as DeepPartial<object>) as T[keyof T];
      } else {
        result[key as keyof T] = val as T[keyof T];
      }
    }
  }
  return result;
}

export const translations: Record<Language, Translations> = {
  en,
  "pt-BR": deepMerge(en, ptBR),
};

export const languageNames: Record<Language, string> = {
  en: "English",
  "pt-BR": "Português (Brasil)",
};

export type { Translations };
