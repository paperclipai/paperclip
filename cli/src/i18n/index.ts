import i18next from "i18next";
import en from "./locales/en.json" with { type: "json" };
import es from "./locales/es.json" with { type: "json" };

function detectLanguage(): string {
  // PAPERCLIP_LANG takes highest priority (e.g. "es", "en")
  if (process.env.PAPERCLIP_LANG) {
    return process.env.PAPERCLIP_LANG.toLowerCase().slice(0, 2);
  }
  // Fall back to system locale
  const raw = process.env.LC_ALL || process.env.LANG || "";
  // e.g. "es_MX.UTF-8" -> "es", "en_US" -> "en"
  const match = raw.match(/^([a-z]{2})/i);
  return match ? match[1].toLowerCase() : "en";
}

await i18next.init({
  lng: detectLanguage(),
  fallbackLng: "en",
  resources: {
    en: { translation: en },
    es: { translation: es },
  },
  interpolation: { escapeValue: false },
});

export const t = i18next.t.bind(i18next);
export default i18next;
