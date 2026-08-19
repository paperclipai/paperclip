import { Languages } from "lucide-react";
import { useTranslation, setAppLocale, supportedLocales } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Locales exposed in the switcher for this Hauptflächen slice.
 * Full catalogs remain loadable; expand this list as nav/page keys are translated.
 */
const SWITCHER_LOCALES = ["en", "de"] as const;

/**
 * Resolve a human label for a locale code.
 * Uses catalog keys when present, otherwise the raw code.
 */
function localeLabel(code: string, t: (key: string, options?: { defaultValue?: string }) => string): string {
  const key = `app.language.${code}`;
  const labeled = t(key, { defaultValue: code });
  return labeled === key ? code : labeled;
}

interface LanguageSwitcherProps {
  /** Optional class name for the outer fieldset. */
  className?: string;
  /** Called after a successful locale change. */
  onAfterChange?: () => void;
}

/**
 * Compact product-language control for Hauptflächen DE-Gate operators.
 * Persists via {@link setAppLocale} (`paperclip.locale`).
 */
export function LanguageSwitcher({ className, onAfterChange }: LanguageSwitcherProps) {
  const { t, i18n } = useTranslation();
  const active = i18n.language;

  const ordered = SWITCHER_LOCALES.filter((code) => supportedLocales.includes(code));

  return (
    <fieldset className={cn("space-y-2", className)}>
      <legend className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Languages className="size-4 text-muted-foreground" aria-hidden />
        {t("app.language.label", { defaultValue: "Language" })}
      </legend>
      <p className="text-xs text-muted-foreground">
        {t("app.language.description", { defaultValue: "Choose the product UI language." })}
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("app.language.label", { defaultValue: "Language" })}>
        {ordered.map((code) => {
          const isActive = active === code || active.startsWith(`${code}-`);
          return (
            <button
              key={code}
              type="button"
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "bg-accent/50 text-foreground hover:bg-accent",
              )}
              aria-pressed={isActive}
              onClick={() => {
                setAppLocale(code);
                onAfterChange?.();
              }}
            >
              {localeLabel(code, t)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
