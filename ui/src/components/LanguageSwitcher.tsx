import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

const LANGUAGES = [
  { code: "en", key: "languageSwitcher.en" },
  { code: "pt-BR", key: "languageSwitcher.ptBR" },
] as const;

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();

  const currentLanguage =
    LANGUAGES.find((language) => language.code === i18n.language)
    ?? LANGUAGES.find((language) => i18n.language.startsWith(language.code))
    ?? LANGUAGES[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground"
          aria-label={t("languageSwitcher.label")}
        >
          <Globe className="h-4 w-4" />
          <span className="text-xs">{t(currentLanguage.key)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[140px]">
        {LANGUAGES.map((language) => (
          <DropdownMenuItem
            key={language.code}
            onClick={() => i18n.changeLanguage(language.code)}
            className={
              i18n.language === language.code ? "font-semibold bg-accent/40" : ""
            }
          >
            {t(language.key)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
