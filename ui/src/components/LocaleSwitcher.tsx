import { Check, Languages } from "lucide-react";
import { i18n, setLocale, supportedLocales, useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";

const SWITCHER_LOCALES = supportedLocales;
const LOCALE_LABEL_KEYS = {
  en: "common.english",
  ru: "common.russian",
} as const;

export function LocaleSwitcher() {
  const { t } = useTranslation();
  const currentLocale = i18n.resolvedLanguage ?? i18n.language;

  return (
    <div className="flex w-full min-w-0 flex-col gap-2 rounded-xl px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="shrink-0 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
          <Languages className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 break-words text-sm font-medium text-foreground">{t("common.language")}</span>
      </div>
      <div className="flex max-h-60 min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain rounded-lg border border-border p-1" role="group" aria-label={t("common.language")}>
        {SWITCHER_LOCALES.map((locale) => (
          <button
            key={locale}
            type="button"
            className={cn(
              "flex min-h-11 w-full min-w-0 shrink-0 items-center gap-2 rounded-md px-2.5 py-2 text-start text-sm font-medium transition-colors",
              currentLocale === locale
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={currentLocale === locale}
            aria-label={t(LOCALE_LABEL_KEYS[locale])}
            lang={locale}
            onClick={() => setLocale(locale)}
          >
            <span className="min-w-0 flex-1 break-words">{t(LOCALE_LABEL_KEYS[locale])}</span>
            <Check className={cn("size-4 shrink-0", currentLocale !== locale && "invisible")} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}
