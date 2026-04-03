import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Globe } from "lucide-react";

export function LanguageSwitcher() {
  const { i18n } = useTranslation();

  const toggleLanguage = () => {
    const newLang = i18n.language.startsWith("pt") ? "en" : "pt";
    i18n.changeLanguage(newLang);
    localStorage.setItem("i18nextLng", newLang);
  };

  const currentLangLabel = i18n.language.startsWith("pt") ? "PT" : "EN";

  return (
    <div className="px-3 py-2 border-t border-border mt-auto">
      <Button
        variant="ghost"
        size="sm"
        onClick={toggleLanguage}
        className="w-full justify-start gap-2.5 text-muted-foreground hover:text-foreground h-9 px-3"
      >
        <Globe className="h-4 w-4 shrink-0" />
        <span className="text-[13px] font-medium">
          {currentLangLabel === "PT" ? "Português" : "English"}
        </span>
      </Button>
    </div>
  );
}
