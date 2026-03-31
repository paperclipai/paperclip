import { useI18n, type ActiveLocale } from "../i18n";

const localeLabels: Record<ActiveLocale, string> = {
  en: "English",
  ko: "한국어",
  ja: "日本語",
};

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">{t("language.label")}</span>
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value)}
        aria-label={t("language.label")}
        className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
      >
        {(Object.keys(localeLabels) as ActiveLocale[]).map((entry) => (
          <option key={entry} value={entry}>
            {localeLabels[entry]}
          </option>
        ))}
      </select>
    </label>
  );
}
