import { Languages } from "lucide-react";

import { cn } from "@/lib/utils";
import { TruncatedText } from "./TruncatedText";
import { availableLocales, setLocale, useTranslation } from "@/i18n";
import { localeDisplayName } from "@/i18n/locale-preference";

type LanguageToggleVariant = "menu-action" | "compact-menu-action";

interface LanguageToggleProps {
  className?: string;
  variant?: LanguageToggleVariant;
  locales?: readonly string[];
  onAfterToggle?: () => void;
}

export function nextLocale(current: string, locales: readonly string[]): string | null {
  if (locales.length < 2) return null;
  const index = locales.indexOf(current);
  return locales[(index + 1) % locales.length] ?? null;
}

export function LanguageToggle({
  className,
  variant = "compact-menu-action",
  locales = availableLocales,
  onAfterToggle,
}: LanguageToggleProps) {
  const { t, i18n } = useTranslation();
  const target = nextLocale(i18n.resolvedLanguage ?? i18n.language, locales);
  if (!target) return null;

  const targetName = localeDisplayName(target);
  const label = t("app.language.switchTo", { language: targetName });

  function handleClick() {
    if (!target) return;
    void setLocale(target);
    onAfterToggle?.();
  }

  if (variant === "menu-action") {
    return (
      <button
        type="button"
        className={cn(
          "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent/60",
          className,
        )}
        onClick={handleClick}
        aria-label={label}
      >
        <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
          <Languages className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{label}</span>
          <span className="block text-xs text-muted-foreground">{t("app.language.description")}</span>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={cn(
        "flex h-(--profile-popover-row-height) w-full items-center gap-(--profile-popover-row-gap) rounded-lg px-2.5 text-left text-(length:--text-compact) font-medium leading-(--profile-popover-label-line-height) text-foreground transition-colors hover:bg-accent",
        className,
      )}
      onClick={handleClick}
      aria-label={label}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        <Languages className="size-4" />
      </span>
      <TruncatedText className="min-w-0 flex-1 truncate">{label}</TruncatedText>
    </button>
  );
}
