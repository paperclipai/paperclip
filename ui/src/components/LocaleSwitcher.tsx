import { Check, Globe } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { LOCALE_NATIVE_NAMES, getLocale, setLocale, supportedLocales } from "@/i18n";

type LocaleSwitcherVariant = "icon" | "menu-action";

interface LocaleSwitcherProps {
  className?: string;
  /**
   * `icon` (default): compact icon button that opens a dropdown — suitable
   * for headers and floating chrome (e.g. the unauthenticated `/auth` page),
   * mirroring `ThemeToggle`'s icon variant.
   *
   * `menu-action`: full-width row with label + description + icon — matches
   * the surrounding `MenuAction` rows in `SidebarAccountMenu`.
   */
  variant?: LocaleSwitcherVariant;
  /**
   * Called after a new locale is applied. Surfaces like a popover menu use
   * this to dismiss the menu once the user has acted.
   */
  onAfterSelect?: () => void;
}

const MENU_ACTION_DESCRIPTION = "Choose the interface language.";

/**
 * Canonical language-switcher widget. Mirrors `ThemeToggle`'s two-variant
 * API so it can sit next to it on the signed-out `/auth` chrome (icon) and
 * inside the in-app account menu (menu-action).
 */
export function LocaleSwitcher({ className, variant = "icon", onAfterSelect }: LocaleSwitcherProps) {
  const { t } = useTranslation();
  const current = getLocale();
  const label = LOCALE_NATIVE_NAMES[current] ?? current;

  function handleSelect(locale: string) {
    setLocale(locale);
    onAfterSelect?.();
  }

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
            aria-label={`Language: ${label}`}
          >
            <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
              <Globe className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{label}</span>
              <span className="block text-xs text-muted-foreground">{MENU_ACTION_DESCRIPTION}</span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
          <DropdownMenuLabel>{t("localeSwitcher.text.language")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {supportedLocales.map((locale) => (
            <DropdownMenuItem
              key={locale}
              onClick={() => handleSelect(locale)}
              className="flex items-center justify-between gap-3"
            >
              <span>{LOCALE_NATIVE_NAMES[locale] ?? locale}</span>
              {locale === current && <Check className="size-4 opacity-70" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
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
          aria-label={`Language: ${label}`}
          title={`Language: ${label}`}
          className={cn("text-muted-foreground", className)}
        >
          <Globe />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        <DropdownMenuLabel>{t("localeSwitcher.text.language")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {supportedLocales.map((locale) => (
          <DropdownMenuItem
            key={locale}
            onClick={() => handleSelect(locale)}
            className="flex items-center justify-between gap-3"
          >
            <span>{LOCALE_NATIVE_NAMES[locale] ?? locale}</span>
            {locale === current && <Check className="size-4 opacity-70" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
