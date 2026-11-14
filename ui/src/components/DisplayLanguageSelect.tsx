import { Languages } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  DISPLAY_LOCALES,
  getDisplayLocale,
  setDisplayLocale,
  type DisplayLocale,
} from "@/i18n/display-text";

const LANGUAGE_NAMES: Record<DisplayLocale, string> = {
  en: "English",
  fr: "Français",
};

function isDisplayLocale(value: string): value is DisplayLocale {
  return (DISPLAY_LOCALES as readonly string[]).includes(value);
}

interface DisplayLanguageSelectProps {
  className?: string;
  onLocaleChange?: (locale: DisplayLocale) => void;
}

function reloadPage() {
  window.location.reload();
}

export function DisplayLanguageSelect({ className, onLocaleChange = reloadPage }: DisplayLanguageSelectProps) {
  return (
    <label className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)}>
      <span className="flex size-5 shrink-0 items-center justify-center">
        <Languages className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate">Language</span>
      <select
        data-no-translate
        defaultValue={getDisplayLocale()}
        onChange={(event) => {
          const locale = event.target.value;
          if (!isDisplayLocale(locale)) return;
          setDisplayLocale(locale);
          onLocaleChange(locale);
        }}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
      >
        {DISPLAY_LOCALES.map((locale) => (
          <option key={locale} value={locale} lang={locale}>
            {LANGUAGE_NAMES[locale]}
          </option>
        ))}
      </select>
    </label>
  );
}
