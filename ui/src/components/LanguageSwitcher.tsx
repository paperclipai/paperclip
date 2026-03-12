import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
] as const;

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const currentLang = i18n.language?.split("-")[0] ?? "en";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          aria-label="Switch language"
        >
          <Globe className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end">
        {LANGUAGES.map((lang) => {
          const active = currentLang === lang.code;
          return (
            <Button
              key={lang.code}
              variant="ghost"
              size="sm"
              className={cn(
                "w-full justify-start gap-2 text-xs",
                active && "bg-accent",
              )}
              onClick={() => {
                i18n.changeLanguage(lang.code);
                setOpen(false);
              }}
            >
              <span className="flex-1 text-left">{lang.label}</span>
              {active && <Check className="h-3.5 w-3.5 text-foreground" />}
            </Button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
