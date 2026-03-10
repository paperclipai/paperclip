import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          title={t("languageSwitcher.title")}
        >
          <Languages className="h-4 w-4" />
          <span className="sr-only">{t("languageSwitcher.title")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => changeLanguage("en-US")}>
          English (US)
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => changeLanguage("zh-CN")}>
          简体中文
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => changeLanguage("zh-HK")}>
          繁體中文
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => changeLanguage("ja-JP")}>
          日本語
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => changeLanguage("ko-KR")}>
          한국어
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
