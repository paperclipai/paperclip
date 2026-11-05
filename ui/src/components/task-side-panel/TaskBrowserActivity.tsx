import { t, useTranslation } from "@/i18n";
import type { TaskBrowser } from "@paperclipai/shared";
import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button";

export function TaskBrowserActivity({
  browser,
  label = t("final-components-a:browser_d31de1a5"),
  onOpen,
}: {
  browser: TaskBrowser;
  label?: string;
  onOpen?: (id: string) => void;
}) {
  useTranslation("task-components");
  const closed = browser.status === "closed" || browser.status === "failed";
  return (
    <div className="flex flex-wrap items-center gap-2 py-1 text-sm" aria-label={t("task-components:session_2eccb41c", { value1: label })}>
      <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span>{label}</span>
      <span className="text-muted-foreground">· {browser.status}</span>
      {onOpen && (
        <Button variant="ghost" size="sm" onClick={() => onOpen(browser.id)}>
          {closed ? t("task-components:viewSession_4fbf3281") : t("task-components:openBrowser_b84a7dc0")}
        </Button>
      )}
    </div>
  );
}
