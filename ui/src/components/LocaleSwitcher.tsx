import { useLocale } from "@/context/LocaleContext";

export function LocaleSwitcher({
  className = "",
  showLabel = true,
}: {
  className?: string;
  showLabel?: boolean;
}) {
  const { locale, supportedLocales, localeOptionLabels, setLocalePreference, isUpdatingLocale, t } = useLocale();

  return (
    <label className={`inline-flex items-center gap-2 text-xs text-muted-foreground ${className}`.trim()}>
      {showLabel ? <span>{t("common.language")}</span> : null}
      <select
        value={locale}
        disabled={isUpdatingLocale}
        onChange={(event) => {
          void setLocalePreference(event.target.value as typeof locale);
        }}
        className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
        aria-label={t("common.language")}
      >
        {supportedLocales.map((entry) => (
          <option key={entry} value={entry}>
            {localeOptionLabels[entry]}
          </option>
        ))}
      </select>
    </label>
  );
}
