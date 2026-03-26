import { useTranslation } from "react-i18next";
import { setLanguage, supportedLanguages } from "./index";
import { Globe } from "lucide-react";

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { i18n } = useTranslation();

  if (compact) {
    // Cycle through languages on click
    const currentIndex = supportedLanguages.findIndex((l) => l.code === i18n.language);
    const nextIndex = (currentIndex + 1) % supportedLanguages.length;
    const nextLang = supportedLanguages[nextIndex];
    const shortLabel: Record<string, string> = { en: "EN", "zh-TW": "中", ja: "日", ko: "한" };

    return (
      <button
        onClick={() => setLanguage(nextLang.code)}
        className="inline-flex items-center justify-center rounded-md w-7 h-7 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        title={`${shortLabel[i18n.language] ?? "EN"} → ${nextLang.label}`}
      >
        <Globe className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Globe className="h-4 w-4 text-muted-foreground" />
      <select
        value={i18n.language}
        onChange={(e) => setLanguage(e.target.value)}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
      >
        {supportedLanguages.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.label}
          </option>
        ))}
      </select>
    </div>
  );
}
