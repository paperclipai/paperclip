import { Languages } from "lucide-react";

import { i18n, setAppLocale, useTranslation } from "@/i18n";
import { supportedLocales } from "@/i18n/locales";
import { cn } from "@/lib/utils";

interface LanguageSelectProps {
  className?: string;
}

function localeNativeName(tag: string): string {
  try {
    return new Intl.DisplayNames([tag], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

export function LanguageSelect({ className }: LanguageSelectProps) {
  const { t } = useTranslation();
  const label = t("settings.language.label");
  const description = t("settings.language.description");
  const current = supportedLocales.includes(i18n.language) ? i18n.language : "en";

  return (
    <label
      className={cn(
        "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent/60",
        className,
      )}
    >
      <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
        <Languages className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
        <select
          aria-label={label}
          className="mt-2 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={current}
          onChange={(event) => setAppLocale(event.target.value)}
        >
          {supportedLocales.map((locale) => (
            <option key={locale} value={locale}>
              {localeNativeName(locale)}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}
