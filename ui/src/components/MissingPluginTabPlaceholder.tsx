import { useTranslation } from "@/i18n";
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
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-dashed border-border bg-background px-4 py-8 text-sm text-muted-foreground">
      <div className="flex flex-col items-start gap-3">
        <p>{t("localizationPlugins.ui_Workspace_plugin_tab_is_not_available_")}</p>
        <Button variant="outline" size="sm" asChild>
          <Link to={defaultTabHref}>{defaultTabLabel}</Link>
        </Button>
      </div>
    </div>
  );
}
