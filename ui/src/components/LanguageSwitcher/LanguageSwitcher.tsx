import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { setLanguage, SUPPORTED_LANGUAGES, LANGUAGE_NATIVE_NAMES, type SupportedLanguage } from "@/locales/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import styles from "./LanguageSwitcher.module.css";

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const current = i18n.language as SupportedLanguage;
  return (
    <div className={`language-switcher ${styles.languageSwitcher}`}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Change language"
            className={styles.trigger}
          >
            <Languages className={styles.icon} />
            <span className={styles.label}>{LANGUAGE_NATIVE_NAMES[current] ?? current}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {SUPPORTED_LANGUAGES.map((lang) => (
            <DropdownMenuItem
              key={lang}
              onSelect={() => setLanguage(lang)}
              className={lang === current ? styles.active : undefined}
            >
              {LANGUAGE_NATIVE_NAMES[lang]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
