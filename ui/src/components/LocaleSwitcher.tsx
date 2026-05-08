import { useLocale } from "@/i18n/LocaleContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const LOCALE_LABELS: Record<string, string> = {
  en: "English",
  zh: "中文",
};

export function LocaleSwitcher() {
  const { locale, setLocale, supportedLocales } = useLocale();

  return (
    <Select
      value={locale}
      onValueChange={(value) => {
        setLocale(value as typeof locale);
      }}
    >
      <SelectTrigger className="w-[120px]">
        <SelectValue placeholder="Language" />
      </SelectTrigger>
      <SelectContent>
        {supportedLocales.map((lng) => (
          <SelectItem key={lng} value={lng}>
            {LOCALE_LABELS[lng] ?? lng}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
