import { Globe } from "lucide-react";

import {
  operatorLocaleNames,
  operatorLocales,
  setOperatorLocale,
  useTranslation,
  type OperatorLocale,
} from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type LocaleSwitcherVariant = "icon" | "menu-action";

interface LocaleSwitcherProps {
  className?: string;
  variant?: LocaleSwitcherVariant;
  onAfterSelect?: () => void;
}

export function LocaleSwitcher({ className, variant = "icon", onAfterSelect }: LocaleSwitcherProps) {
  const { i18n } = useTranslation();
  const currentLocale = operatorLocales.includes(i18n.resolvedLanguage as OperatorLocale)
    ? (i18n.resolvedLanguage as OperatorLocale)
    : "en";
  const currentName = operatorLocaleNames[currentLocale];

  async function selectLocale(locale: string) {
    if (!operatorLocales.includes(locale as OperatorLocale)) return;
    await setOperatorLocale(locale as OperatorLocale);
    onAfterSelect?.();
  }

  const menu = (
    <DropdownMenuContent align={variant === "icon" ? "end" : "start"}>
      <DropdownMenuRadioGroup value={currentLocale} onValueChange={selectLocale}>
        {operatorLocales.map((locale) => (
          <DropdownMenuRadioItem key={locale} value={locale} className="flex items-center gap-2">
            {operatorLocaleNames[locale]}
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
            aria-label={`Change interface language. Current: ${currentName}`}
          >
            <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
              <Globe className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{currentName}</span>
              <span className="block text-xs text-muted-foreground">Interface language</span>
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
          aria-label={`Change interface language. Current: ${currentName}`}
          title={`Language: ${currentName}`}
          className={cn("text-muted-foreground", className)}
        >
          <Globe />
        </Button>
      </DropdownMenuTrigger>
      {menu}
    </DropdownMenu>
  );
}
