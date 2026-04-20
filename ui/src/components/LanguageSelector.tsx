import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { loadLanguage } from "@/i18n";

interface AvailableLanguage {
  code: string;
  source: "core" | "plugin";
  pluginKey?: string;
}

/** Well-known language labels. Plugins providing new languages appear by code. */
const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  ko: "한국어",
  ja: "日本語",
  zh: "中文",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  ru: "Русский",
};

export function LanguageSelector() {
  const { i18n } = useTranslation();
  const [languages, setLanguages] = useState<AvailableLanguage[]>([
    { code: "en", source: "core" },
  ]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/languages");
        if (!res.ok || cancelled) return;
        const data = await res.json() as AvailableLanguage[];
        if (!cancelled && data.length > 0) {
          // EN is always first (Core), then plugin-provided languages
          const merged: AvailableLanguage[] = [{ code: "en", source: "core" }];
          for (const lang of data) {
            if (lang.code !== "en") {
              merged.push(lang);
            }
          }
          setLanguages(merged);
        }
      } catch {
        // API unavailable — only EN available
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleChange = async (lng: string) => {
    // Load language bundles before switching (avoids FOUC)
    await loadLanguage(lng);
    i18n.changeLanguage(lng);
    localStorage.setItem("paperclip.language", lng);
    document.documentElement.lang = lng;
  };

  return (
    <div className="max-w-xs">
      <Select value={i18n.language} onValueChange={(v) => void handleChange(v)}>
        <SelectTrigger className="w-full">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
            <SelectValue />
          </div>
        </SelectTrigger>
        <SelectContent>
          {languages.map((lang) => (
            <SelectItem key={lang.code} value={lang.code}>
              {LANGUAGE_LABELS[lang.code] ?? lang.code.toUpperCase()}
              {lang.source === "plugin" && (
                <span className="ml-1 text-xs text-muted-foreground">(plugin)</span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
