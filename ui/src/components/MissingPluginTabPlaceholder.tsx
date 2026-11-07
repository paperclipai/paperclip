import { t, useTranslation } from "@/i18n";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";

interface MissingPluginTabPlaceholderProps {
  defaultTabHref: string;
  defaultTabLabel: string;
}

export function MissingPluginTabPlaceholder({
  defaultTabHref,
  defaultTabLabel,
}: MissingPluginTabPlaceholderProps) {
  useTranslation("task-components");
  return (
    <div className="rounded-lg border border-dashed border-border bg-background px-4 py-8 text-sm text-muted-foreground">
      <div className="flex flex-col items-start gap-3">
        <p>{t("task-components:workspacePluginTabIsNotAvailable_a825d1d1")}</p>
        <Button variant="outline" size="sm" asChild>
          <Link to={defaultTabHref}>{defaultTabLabel}</Link>
        </Button>
      </div>
    </div>
  );
}
