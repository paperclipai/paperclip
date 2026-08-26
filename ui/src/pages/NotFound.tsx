import { useEffect } from "react";
import { Link, useLocation } from "@/lib/router";
import { AlertTriangle, Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { t, useTranslation } from "@/i18n";

type NotFoundScope = "board" | "invalid_company_prefix" | "global";

interface NotFoundPageProps {
  scope?: NotFoundScope;
  requestedPrefix?: string;
}

export function NotFoundPage({ scope = "global", requestedPrefix }: NotFoundPageProps) {
  const location = useLocation();
  const { t } = useTranslation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { companies, selectedCompany } = useCompany();

  useEffect(() => {
    setBreadcrumbs([{ label: t("app.pages.notFound", { defaultValue: "Not Found" }) }]);
  }, [setBreadcrumbs]);

  const fallbackCompany = selectedCompany ?? companies[0] ?? null;
  const dashboardHref = fallbackCompany ? `/${fallbackCompany.issuePrefix}/dashboard` : "/";
  const currentPath = `${location.pathname}${location.search}${location.hash}`;
  const normalizedPrefix = requestedPrefix?.toUpperCase();

  const title = scope === "invalid_company_prefix" ? t("app.notFound.companyNotFound", { defaultValue: "Company not found" }) : t("app.notFound.pageNotFound", { defaultValue: "Page not found" });
  const description =
    scope === "invalid_company_prefix"
      ? `No company matches prefix "${normalizedPrefix ?? "unknown"}".`
      : t("app.notFound.thisRouteDoesNotExist", { defaultValue: "This route does not exist." });

  return (
    <div className="mx-auto max-w-2xl py-10">
      <Card className="block p-6">
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
          {t("app.notFound.requestedPath", { defaultValue: "Requested path: " })}<code className="font-mono">{currentPath}</code>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild>
            <Link to={dashboardHref}>
              <Compass className="mr-1.5 h-4 w-4" />
              {t("app.notFound.openDashboard", { defaultValue: "Open dashboard" })}</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/">{t("app.notFound.goHome", { defaultValue: "Go home" })}</Link>
          </Button>
        </div>
      </Card>
    </div>
  );
}
