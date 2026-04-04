import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { supportedLanguages, type SupportedLanguage } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

export function LanguageSwitcher() {
  const { i18n } = useTranslation();

  const languages = Object.entries(supportedLanguages) as [SupportedLanguage, string][];
  const currentIndex = languages.findIndex(([code]) => i18n.language.startsWith(code));
  const nextIndex = (currentIndex + 1) % languages.length;
  const [nextCode, nextLabel] = languages[nextIndex]!;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          onClick={() => i18n.changeLanguage(nextCode)}
        >
          <Languages className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{nextLabel}</TooltipContent>
    </Tooltip>
  );
}
