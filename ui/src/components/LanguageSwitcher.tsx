import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SUPPORTED_LANGUAGES, type LanguageCode } from "../i18n/i18n";

interface LanguageSwitcherProps {
  className?: string;
}

export function LanguageSwitcher({ className }: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation();
  const currentLang = i18n.language as LanguageCode;

  function toggleLanguage() {
    const next = currentLang === "en" ? "zh" : "en";
    i18n.changeLanguage(next);
  }

  const currentLabel =
    SUPPORTED_LANGUAGES.find((l) => l.code === currentLang)?.nativeLabel ?? "EN";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={className}
      onClick={toggleLanguage}
      aria-label={t("common.language")}
      title={t("common.language")}
    >
      <Languages className="h-4 w-4" />
      <span className="sr-only">{currentLabel}</span>
    </Button>
  );
}
