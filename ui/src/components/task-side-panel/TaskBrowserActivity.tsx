import { t, useTranslation } from "@/i18n";
import type { TaskBrowser } from "@paperclipai/shared";
import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button";

export function TaskBrowserActivity({
  browser,
  label = "Browser",
  onOpen,
}: {
  browser: TaskBrowser;
  label?: string;
  onOpen?: (id: string) => void;
}) {
  useTranslation();
  const numberedLabel = /^Browser (\d+)$/.exec(label);
  const displayLabel = label === "Browser" ? t("oct5Core.s0159") : numberedLabel ? t("oct5Core.browserNumber", { number: numberedLabel[1] }) : label;
  const closed = browser.status === "closed" || browser.status === "failed";
  return (
    <div className="flex flex-wrap items-center gap-2 py-1 text-sm" aria-label={t("oct5Core.browserSession", { label: displayLabel })}>
      <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span>{displayLabel}</span>
      <span className="text-muted-foreground">· {t(`oct5Core.browserState_${browser.status}`)}</span>
      {onOpen && (
        <Button variant="ghost" size="sm" onClick={() => onOpen(browser.id)}>
          {closed ? t("oct5Core.s0160") : t("oct5Core.s0161")}
        </Button>
      )}
    </div>
  );
}
