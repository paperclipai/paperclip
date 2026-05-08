import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { setLanguage, SUPPORTED_LANGUAGES, LANGUAGE_NATIVE_NAMES, type SupportedLanguage } from "@/locales/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation("common");
  const current = i18n.language as SupportedLanguage;
  return (
    <div className="inline-flex items-center">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("language_switcher.change_language")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-accent/50 cursor-pointer"
          >
            <Languages className="size-3.5 shrink-0" />
            <span>{LANGUAGE_NATIVE_NAMES[current] ?? current}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {SUPPORTED_LANGUAGES.map((lang) => (
            <DropdownMenuItem
              key={lang}
              onSelect={() => setLanguage(lang)}
              className={cn(lang === current && "bg-accent/50 font-semibold")}
            >
              {LANGUAGE_NATIVE_NAMES[lang]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
