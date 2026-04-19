import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGS, type SupportedLang } from "@/i18n";

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current = (SUPPORTED_LANGS as readonly string[]).includes(i18n.resolvedLanguage ?? "")
    ? (i18n.resolvedLanguage as SupportedLang)
    : "en";

  return (
    <label className="flex items-center gap-2 px-2 py-1 text-[12px] text-muted-foreground">
      <Languages className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="sr-only">{t("language.label")}</span>
      <select
        value={current}
        onChange={(e) => {
          const next = e.target.value as SupportedLang;
          i18n.changeLanguage(next);
        }}
        className="flex-1 bg-transparent border border-border rounded px-1.5 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label={t("language.label")}
      >
        {SUPPORTED_LANGS.map((lang) => (
          <option key={lang} value={lang}>
            {t(`language.${lang}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
