import { useEffect } from "react";
import { Link, useLocation } from "@/lib/router";
import { AlertTriangle, Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useI18n } from "../context/I18nContext";

type NotFoundScope = "board" | "invalid_company_prefix" | "global";

interface NotFoundPageProps {
  scope?: NotFoundScope;
  requestedPrefix?: string;
}

export function NotFoundPage({ scope = "global", requestedPrefix }: NotFoundPageProps) {
  const { t } = useI18n();
  const location = useLocation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { companies, selectedCompany } = useCompany();

  useEffect(() => {
    setBreadcrumbs([{ label: t("not_found.page_not_found") }]);
  }, [setBreadcrumbs, t]);

  const fallbackCompany = selectedCompany ?? companies[0] ?? null;
  const dashboardHref = fallbackCompany ? `/${fallbackCompany.issuePrefix}/dashboard` : "/";
  const currentPath = `${location.pathname}${location.search}${location.hash}`;
  const normalizedPrefix = requestedPrefix?.toUpperCase();

  const title = scope === "invalid_company_prefix" ? t("not_found.company_not_found") : t("not_found.page_not_found");
  const description =
    scope === "invalid_company_prefix"
      ? t("not_found.no_company_matches_prefix", {
          prefix: normalizedPrefix ?? t("common.unknown"),
        })
      : t("not_found.route_missing");

  return (
    <div className="mx-auto max-w-2xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex items-center gap-3">
          <div className="rounded-md border border-destructive/20 bg-destructive/10 p-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>

        <div className="mt-4 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {t("not_found.requested_path")}: <code className="font-mono">{currentPath}</code>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild>
            <Link to={dashboardHref}>
              <Compass className="mr-1.5 h-4 w-4" />
              {t("not_found.open_dashboard")}
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/">{t("not_found.go_home")}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
