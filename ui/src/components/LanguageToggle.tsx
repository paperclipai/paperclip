import { Globe } from "lucide-react";
import { changeLanguage, getCurrentLocale, supportedLocales } from "@/i18n";
import { cn } from "@/lib/utils";

interface LanguageToggleProps {
  className?: string;
  variant?: "icon" | "compact-menu-action";
  onAfterToggle?: () => void;
}

interface LanguageOption {
  code: string;
  label: string;
  name: string;
}

export const PRIMARY_LANGUAGES: LanguageOption[] = [
  { code: "en", label: "Language: English", name: "English" },
  { code: "pt-BR", label: "Idioma: Português (BR)", name: "Português (Brasil)" },
  { code: "pt-PT", label: "Idioma: Português (PT)", name: "Português (Portugal)" },
];

export function getLanguageDetails(current: string): { label: string; name: string } {
  const match = PRIMARY_LANGUAGES.find((opt) => opt.code === current);
  if (match) {
    return { label: match.label, name: match.name };
  }
  try {
    const dn = new Intl.DisplayNames([current, "en"], { type: "language" });
    const resolved = dn.of(current);
    if (resolved) {
      const formatted = resolved.charAt(0).toUpperCase() + resolved.slice(1);
      const prefix = current.startsWith("pt") ? "Idioma: " : "Language: ";
      return { label: `${prefix}${formatted}`, name: formatted };
    }
  } catch {
    // Fallback if Intl.DisplayNames is not supported or locale is unrecognized
  }
  return { label: `Language: ${current}`, name: current };
}

export function getNextLocale(current: string): string {
  if (current === "en") return "pt-BR";
  if (current === "pt-BR") return "pt-PT";
  return "en";
}

export function LanguageToggle({ className, variant = "compact-menu-action", onAfterToggle }: LanguageToggleProps) {
  const current = getCurrentLocale();
  const { label } = getLanguageDetails(current);
  const nextLocale = getNextLocale(current);

  function handleSelect(newLocale: string) {
    changeLanguage(newLocale);
    onAfterToggle?.();
  }

  function handleToggleClick() {
    changeLanguage(nextLocale);
    onAfterToggle?.();
  }

  const options = [
    ...PRIMARY_LANGUAGES,
    ...(supportedLocales || [])
      .filter((loc) => !PRIMARY_LANGUAGES.some((p) => p.code === loc))
      .map((code) => {
        const { name } = getLanguageDetails(code);
        return { code, label: `Language: ${name}`, name };
      }),
  ];

  if (variant === "compact-menu-action") {
    return (
      <div
        className={cn(
          "relative flex h-(--profile-popover-row-height) w-full items-center gap-(--profile-popover-row-gap) rounded-lg px-2.5 text-left text-(length:--text-compact) font-medium leading-(--profile-popover-label-line-height) text-foreground transition-colors hover:bg-accent",
          className,
        )}
      >
        <button
          type="button"
          onClick={handleToggleClick}
          aria-label={label}
          className="flex min-w-0 flex-1 items-center gap-(--profile-popover-row-gap)"
        >
          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
            <Globe className="size-4" />
          </span>
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        </button>
        <select
          value={current}
          onChange={(e) => handleSelect(e.target.value)}
          aria-label="Select language"
          title="Select language"
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        >
          {options.map((opt) => (
            <option key={opt.code} value={opt.code}>
              {opt.name}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className={cn("relative inline-flex items-center justify-center", className)}>
      <button
        type="button"
        onClick={handleToggleClick}
        aria-label={label}
        title={label}
        className="text-muted-foreground hover:text-foreground"
      >
        <Globe className="size-4" />
      </button>
      <select
        value={current}
        onChange={(e) => handleSelect(e.target.value)}
        aria-label="Select language"
        title="Select language"
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      >
        {options.map((opt) => (
          <option key={opt.code} value={opt.code}>
            {opt.name}
          </option>
        ))}
      </select>
    </div>
  );
}
