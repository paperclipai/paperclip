import { useTranslation } from "react-i18next";
import { Globe, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

const LANGUAGES = [
  { code: "en", label: "English", flag: "🇺🇸" },
  { code: "pt-BR", label: "Português (Brasil)", flag: "🇧🇷" },
];

export function LanguageSelector() {
  const { t, i18n } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t("common.language")}>
          <Globe className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {LANGUAGES.map((lang) => {
          const currentLang = i18n.language || i18n.resolvedLanguage;
          const isActive = currentLang?.toLowerCase() === lang.code.toLowerCase() || 
                          currentLang?.toLowerCase().startsWith(lang.code.toLowerCase() + "-");
          return (
            <DropdownMenuItem
              key={lang.code}
              onClick={() => i18n.changeLanguage(lang.code)}
              className={isActive ? "bg-accent/50 font-medium" : ""}
            >
              <span className="mr-2 w-4 text-center">{lang.flag}</span>
              <span className="flex-1">{lang.label}</span>
              {isActive && <Check className="ml-2 h-4 w-4 text-blue-500" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

