import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getSupportedLanguages, subscribeToLanguages } from "../i18n";
import { Globe } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

export function LanguageSelector() {
  const { t, i18n } = useTranslation();
  const [languages, setLanguages] = useState(getSupportedLanguages());

  useEffect(() => {
    return subscribeToLanguages(() => {
      setLanguages(getSupportedLanguages());
    });
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t("common.language")}>
          <Globe className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {languages.map((lang) => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => i18n.changeLanguage(lang.code)}
            className={i18n.resolvedLanguage === lang.code ? "bg-accent font-medium" : ""}
          >
            <span className="mr-2">{lang.flag}</span>
            {lang.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
