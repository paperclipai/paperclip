import { useId, useState } from "react";
import { Label } from "@/components/ui/label";
import { getLocale, setLocale, supportedLocales, useTranslation } from "@/i18n";

const LANGUAGE_NAMES: Record<string, string> = {
  ar: "العربية",
  bn: "বাংলা",
  cs: "Čeština",
  da: "Dansk",
  de: "Deutsch",
  el: "Ελληνικά",
  en: "English",
  es: "Español",
  fa: "فارسی",
  fi: "Suomi",
  fil: "Filipino",
  fr: "Français",
  he: "עברית",
  hi: "हिन्दी",
  hu: "Magyar",
  id: "Bahasa Indonesia",
  it: "Italiano",
  ja: "日本語",
  ko: "한국어",
  mr: "मराठी",
  ms: "Bahasa Melayu",
  nb: "Norsk bokmål",
  nl: "Nederlands",
  pa: "ਪੰਜਾਬੀ",
  pl: "Polski",
  "pt-BR": "Português (Brasil)",
  "pt-PT": "Português (Portugal)",
  ro: "Română",
  ru: "Русский",
  sv: "Svenska",
  sw: "Kiswahili",
  ta: "தமிழ்",
  te: "తెలుగు",
  th: "ไทย",
  tr: "Türkçe",
  uk: "Українська",
  ur: "اردو",
  vi: "Tiếng Việt",
  "zh-CN": "中文 (简体)",
  "zh-TW": "中文 (繁體)",
};

function localeLabel(code: string) {
  return LANGUAGE_NAMES[code] ?? code;
}

export function LanguageSelector() {
  const { t, i18n } = useTranslation();
  const selectId = useId();
  const [value, setValue] = useState(() => getLocale());

  const options = [...supportedLocales].sort((a, b) =>
    localeLabel(a).localeCompare(localeLabel(b)),
  );

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    setValue(next);
    setLocale(next);
  }

  // Keep local state aligned if language changes elsewhere
  if (i18n.language !== value && supportedLocales.includes(i18n.language)) {
    setValue(i18n.language);
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={selectId}>
        {t("app.settings.language.label", { defaultValue: "Language" })}
      </Label>
      <select
        id={selectId}
        value={value}
        onChange={handleChange}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        {options.map((code) => (
          <option key={code} value={code}>
            {localeLabel(code)}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        {t("app.settings.language.description", {
          defaultValue: "Choose the interface language for the board.",
        })}
      </p>
    </div>
  );
}
