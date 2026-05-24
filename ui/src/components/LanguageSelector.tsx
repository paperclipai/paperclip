import { useId, useState } from "react";
import { Label } from "@/components/ui/label";
import { getLocale, setLocale, supportedLocales, useTranslation } from "@/i18n";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  tr: "Türkçe",
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
