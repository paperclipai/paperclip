import { Globe2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DEFAULT_LOCALE,
  getLocaleDisplayName,
  matchSupportedLocale,
  setLocale,
  supportedLocales,
  useTranslation,
} from "@/i18n";
import { cn } from "@/lib/utils";

type LocaleSwitcherVariant = "icon" | "menu-action";

interface LocaleSwitcherProps {
  className?: string;
  variant?: LocaleSwitcherVariant;
  onAfterSelect?: () => void;
}

const localeOptions = [DEFAULT_LOCALE, ...supportedLocales.filter((locale) => locale !== DEFAULT_LOCALE)];

export function LocaleSwitcher({
  className,
  variant = "icon",
  onAfterSelect,
}: LocaleSwitcherProps) {
  const { i18n } = useTranslation();
  const currentLocale =
    matchSupportedLocale(i18n.resolvedLanguage ?? i18n.language) ?? DEFAULT_LOCALE;
  const currentLocaleName = getLocaleDisplayName(currentLocale);
  const accessibleLabel = `${currentLocaleName} (${currentLocale})`;

  function handleLocaleChange(locale: string) {
    void setLocale(locale).then(() => onAfterSelect?.());
  }

  const localeMenu = (
    <DropdownMenuContent
      align={variant === "menu-action" ? "start" : "end"}
      className="w-(--sz-16rem)"
    >
      <DropdownMenuRadioGroup value={currentLocale} onValueChange={handleLocaleChange}>
        {localeOptions.map((locale) => (
          <DropdownMenuRadioItem key={locale} value={locale}>
            <span className="min-w-0 flex-1 truncate">{getLocaleDisplayName(locale)}</span>
            <span className="font-mono text-xs text-muted-foreground">{locale}</span>
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
            aria-label={accessibleLabel}
          >
            <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
              <Globe2 className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{currentLocaleName}</span>
              <span className="block font-mono text-xs text-muted-foreground">{currentLocale}</span>
            </span>
          </button>
        </DropdownMenuTrigger>
        {localeMenu}
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
          aria-label={accessibleLabel}
          title={accessibleLabel}
          className={cn("text-muted-foreground", className)}
        >
          <Globe2 />
        </Button>
      </DropdownMenuTrigger>
      {localeMenu}
    </DropdownMenu>
  );
}
