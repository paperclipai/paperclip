import { Languages } from "lucide-react";
import { i18n, setLocale, supportedLocales, useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";

const SWITCHER_LOCALES = ["en", "zh-CN"].filter((locale) => supportedLocales.includes(locale));
const LOCALE_LABELS: Record<string, string> = {
  en: "EN",
  "zh-CN": "简中",
};

interface LocaleSwitcherProps {
  compact?: boolean;
}

export function LocaleSwitcher({ compact = false }: LocaleSwitcherProps) {
  const { t } = useTranslation();
  const currentLocale = i18n.resolvedLanguage ?? i18n.language;

  return (
    <div className={cn("flex items-center justify-between gap-(--sz-12px) rounded-xl", compact ? "p-0" : "w-full px-(--sz-12px) py-(--sz-10px)")}>
      {!compact && <div className="flex items-center gap-(--sz-12px)">
        <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
          <Languages className="size-4" />
        </span>
        <span className="text-sm font-medium text-foreground">{t("common.language")}</span>
      </div>}
      <div className="flex rounded-lg border border-border p-0.5" role="group" aria-label={t("common.language")}>
        {SWITCHER_LOCALES.map((locale) => (
          <button
            key={locale}
            type="button"
            className={cn(
              "rounded-md px-(--sz-10px) py-(--sz-4px) text-xs font-medium transition-colors",
              currentLocale === locale
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={currentLocale === locale}
            onClick={() => setLocale(locale)}
          >
            {LOCALE_LABELS[locale] ?? locale}
          </button>
        ))}
      </div>
    </div>
  );
}
