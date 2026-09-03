import { Languages } from "lucide-react";
import { setCurrentLanguage, useCurrentLanguage, useI18nKeyless, type Lang } from "i18n-keyless-react";

import { cn } from "@/lib/utils";
import { languageDisplayName, PRIMARY_LANGUAGE, SUPPORTED_LANGUAGES, useT } from "@/i18n-keyless";

interface LanguageMenuActionProps {
  className?: string;
  /** Called after the language changes; a popover menu uses it to dismiss itself. */
  onAfterChange?: () => void;
}

/**
 * Language picker row for `SidebarAccountMenu`, styled like the `MenuAction`
 * rows around it. The choice persists in `localStorage` through the SDK and
 * is applied on the next boot before the first render. Renders nothing when
 * no translation server is configured (see `ui/src/i18n-keyless.ts`).
 */
export function LanguageMenuAction({ className, onAfterChange }: LanguageMenuActionProps) {
  const t = useT();
  const current = useCurrentLanguage() ?? PRIMARY_LANGUAGE;
  const enabled = useI18nKeyless((state) => Boolean(state.config.API_KEY));
  const label = t("Language");

  if (!enabled) return null;

  return (
    <label
      className={cn(
        "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent/60",
        className,
      )}
    >
      <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
        <Languages className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">
          {t("Translate the interface into your language.")}
        </span>
        <select
          aria-label={label}
          value={current}
          onChange={(event) => {
            setCurrentLanguage(event.target.value as Lang);
            onAfterChange?.();
          }}
          className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
        >
          {SUPPORTED_LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>
              {languageDisplayName(lang)}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}
