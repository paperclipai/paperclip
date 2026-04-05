import { useEffect, useState } from "react";
import { Link, useLocation } from "@/lib/router";
import { AlertTriangle, Compass, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { usePageTitle } from "../hooks/usePageTitle";

type NotFoundScope = "board" | "invalid_company_prefix" | "global";

interface NotFoundPageProps {
  scope?: NotFoundScope;
  requestedPrefix?: string;
}

export function NotFoundPage({ scope = "global", requestedPrefix }: NotFoundPageProps) {
  usePageTitle("Not Found");
  const location = useLocation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { companies, selectedCompany } = useCompany();
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Not Found" }]);
  }, [setBreadcrumbs]);

  const fallbackCompany = selectedCompany ?? companies[0] ?? null;
  const dashboardHref = fallbackCompany ? `/${fallbackCompany.issuePrefix}/dashboard` : "/";
  const currentPath = `${location.pathname}${location.search}${location.hash}`;
  const normalizedPrefix = requestedPrefix?.toUpperCase();

  const title = scope === "invalid_company_prefix" ? "Company not found" : "Page not found";
  const description =
    scope === "invalid_company_prefix"
      ? `No company matches prefix "${normalizedPrefix ?? "unknown"}".`
      : "The page you are looking for does not exist or has been moved.";

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (searchQuery.trim()) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    }
  }

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
          Requested path: <code className="font-mono">{currentPath}</code>
        </div>

        {/* Search input */}
        <form onSubmit={handleSearch} className="mt-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search for what you were looking for..."
              className="pl-10"
            />
          </div>
        </form>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild>
            <Link to={dashboardHref}>
              <Compass className="mr-1.5 h-4 w-4" />
              Go to Dashboard
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/">Go home</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
