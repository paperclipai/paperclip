import { Languages } from "lucide-react";

import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  applyDocumentLang,
  isSelectableLocale,
  writeStoredLocale,
  type SelectableLocale,
} from "@/i18n/preference";

type LanguageSwitcherVariant = "icon" | "menu-action" | "compact-menu-action";

interface LanguageSwitcherProps {
  className?: string;
  variant?: LanguageSwitcherVariant;
  onAfterChange?: () => void;
}

export function LanguageSwitcher({ className, variant = "icon", onAfterChange }: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation();
  const value: SelectableLocale = i18n.resolvedLanguage === "ru" ? "ru" : "en";

  function onChange(next: string) {
    if (!isSelectableLocale(next) || next === value) return;
    writeStoredLocale(next);
    applyDocumentLang(next);
    void i18n.changeLanguage(next);
    onAfterChange?.();
  }

  const select = (
    <select
      aria-label={t("app.locale.label")}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        "bg-transparent text-inherit outline-none",
        variant === "icon" ? "h-8 rounded-md border border-border px-2 text-xs" : "ml-auto max-w-28 bg-transparent",
        className,
      )}
    >
      <option value="en">{t("app.locale.en")}</option>
      <option value="ru">{t("app.locale.ru")}</option>
    </select>
  );

  if (variant === "icon") return select;

  return (
    <label
      className={cn(
        variant === "compact-menu-action"
          ? "flex h-(--profile-popover-row-height) w-full items-center gap-(--profile-popover-row-gap) rounded-lg px-2.5 text-left text-(length:--text-compact) font-medium leading-(--profile-popover-label-line-height) text-foreground"
          : "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium text-foreground",
      )}
    >
      <span className={cn("flex shrink-0 items-center justify-center text-muted-foreground", variant === "compact-menu-action" ? "size-5" : "rounded-lg border border-border bg-background/70 p-2")}>
        <Languages className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate">{t("app.locale.label")}</span>
      {select}
    </label>
  );
}
