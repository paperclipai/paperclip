import { useState } from "react";
import { Languages, ChevronDown } from "lucide-react";
import { i18n, changeLanguage } from "@/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

const languages = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "中文" },
];

export function LanguageSwitcher() {
  const [currentLng, setCurrentLng] = useState(i18n.language);

  function handleChange(code: string) {
    changeLanguage(code);
    setCurrentLng(code);
  }

  const currentLabel = languages.find((l) => l.code === currentLng)?.label ?? "English";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 px-3 text-xs text-muted-foreground hover:text-foreground"
        >
          <Languages className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 text-left truncate">{currentLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-36">
        <DropdownMenuRadioGroup value={currentLng} onValueChange={handleChange}>
          {languages.map((lang) => (
            <DropdownMenuRadioItem key={lang.code} value={lang.code}>
              {lang.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
