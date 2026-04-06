import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Globe, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();

  const setLanguage = (lang: string) => {
    i18n.changeLanguage(lang);
    localStorage.setItem("i18nextLng", lang);
  };

  const currentLang = i18n.language.startsWith("pt") ? "pt" : "en";

  return (
    <div className="px-3 py-2 border-t border-border mt-auto">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2.5 text-muted-foreground hover:text-foreground h-9 px-3 transition-all"
          >
            <Globe className="h-4 w-4 shrink-0 opacity-70" />
            <span className="text-[13px] font-medium grow text-left">
              {currentLang === "pt" ? "Português" : "English"}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[160px] animate-in fade-in-0 zoom-in-95">
          <DropdownMenuItem
            className="flex items-center justify-between cursor-pointer"
            onClick={() => setLanguage("en")}
          >
            <span className="flex items-center gap-2">
              <span className="text-xs font-bold opacity-50">EN</span>
              English
            </span>
            {currentLang === "en" && <Check className="h-4 w-4" />}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="flex items-center justify-between cursor-pointer"
            onClick={() => setLanguage("pt")}
          >
            <span className="flex items-center gap-2">
              <span className="text-xs font-bold opacity-50">PT</span>
              Português
            </span>
            {currentLang === "pt" && <Check className="h-4 w-4" />}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
