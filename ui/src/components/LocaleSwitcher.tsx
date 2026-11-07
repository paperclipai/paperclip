import { Languages } from "lucide-react";

import { useTranslation } from "@/i18n";
import { isSelectableLocale } from "@/i18n/locale-preference";
import { cn } from "@/lib/utils";

interface LocaleSwitcherProps {
  className?: string;
  variant?: "standalone" | "compact-menu-action";
}

export function LocaleSwitcher({ className, variant = "standalone" }: LocaleSwitcherProps) {
  const { i18n, t } = useTranslation("platform");

  return (
    <label className={cn(
      "flex w-full items-center gap-2.5 rounded-lg px-2.5 text-foreground",
      variant === "compact-menu-action"
        ? "h-(--profile-popover-row-height) gap-(--profile-popover-row-gap) text-(length:--text-compact) font-medium leading-(--profile-popover-label-line-height)"
        : "py-2 text-sm",
      className,
    )}>
      <Languages className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1">{t("language")}</span>
      <select
        value={i18n.resolvedLanguage ?? "en"}
        onChange={(event) => {
          const locale = event.currentTarget.value;
          if (isSelectableLocale(locale)) void i18n.changeLanguage(locale);
        }}
        className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="en" lang="en">English</option>
        <option value="zh-CN" lang="zh-CN">简体中文</option>
      </select>
    </label>
  );
}
