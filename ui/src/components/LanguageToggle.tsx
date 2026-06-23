import { Languages } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { setLanguage, useTranslation } from "@/i18n";
import { LANGUAGE_OPTIONS } from "@/i18n/language";

type LanguageToggleVariant = "icon" | "menu-action";

interface LanguageToggleProps {
  className?: string;
  /**
   * `icon` (default): compact globe button — suitable for headers and floating
   * chrome (e.g. the unauthenticated `/auth` page).
   *
   * `menu-action`: full-width row with label + active-language description —
   * matches the surrounding `MenuAction` rows in `SidebarAccountMenu`, sitting
   * alongside the `ThemeToggle`.
   */
  variant?: LanguageToggleVariant;
  /** Where the dropdown opens relative to its trigger. */
  align?: "start" | "center" | "end";
  /** Called after a language is selected (e.g. to dismiss an outer menu). */
  onAfterChange?: () => void;
}

/**
 * Canonical language-switcher widget. Lists the first-class
 * {@link LANGUAGE_OPTIONS} (English + Chinese) and persists the choice through
 * {@link setLanguage}; other registered locales still resolve via i18next's
 * fallback but are not advertised here until fully translated.
 */
export function LanguageToggle({
  className,
  variant = "icon",
  align = "end",
  onAfterChange,
}: LanguageToggleProps) {
  const { t, i18n } = useTranslation();
  const current = i18n.resolvedLanguage ?? i18n.language;
  const activeOption =
    LANGUAGE_OPTIONS.find((option) => option.code === current) ?? LANGUAGE_OPTIONS[0];
  const label = t("language.label", { defaultValue: "Language" });

  function handleSelect(code: string) {
    if (code !== current) {
      void setLanguage(code);
    }
    onAfterChange?.();
  }

  const menu = (
    <DropdownMenuContent align={align} className="w-48">
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup value={current} onValueChange={handleSelect}>
        {LANGUAGE_OPTIONS.map((option) => (
          <DropdownMenuRadioItem key={option.code} value={option.code}>
            {option.nativeLabel}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  );

  if (variant === "menu-action") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent/60",
              className,
            )}
            aria-label={label}
          >
            <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
              <Languages className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{label}</span>
              <span className="block text-xs text-muted-foreground">{activeOption.nativeLabel}</span>
            </span>
          </button>
        </DropdownMenuTrigger>
        {menu}
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          title={label}
          className={cn("text-muted-foreground", className)}
        >
          <Languages />
        </Button>
      </DropdownMenuTrigger>
      {menu}
    </DropdownMenu>
  );
}
