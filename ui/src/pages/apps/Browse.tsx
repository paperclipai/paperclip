import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, Search, ShieldCheck, Sparkles } from "lucide-react";
import type { AppDefinition } from "@paperclipai/shared";
import { getAvailableConnectionMethod } from "@paperclipai/shared";

import { useNavigate, useSearchParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AppLogo } from "./AppLogo";
import { MethodBadges } from "./connect/MethodSelect";
import { AdvancedToolsLink } from "./store-cards";

/**
 * Door 1 — Browse (the store), Connections v3 §3.
 *
 * A browsable storefront: a category rail with counts, a featured row, and the
 * full gallery with method badges. **Every tile is clickable** — the
 * "Coming soon" era ends with P4; each tile opens the Add-Connection wizard.
 * Availability injection still gates genuinely unavailable *methods* inside the
 * wizard (with an explanation), not whole tiles. Generic OAuth / API-Key escape
 * hatches are pinned at the top, and a "Suggest a connector" card closes the
 * grid (and stands in for empty search results) to feed wave planning.
 */

const CATEGORY_LABELS: Record<string, string> = {
  ai: "AI",
  analytics: "Analytics",
  commerce: "Commerce",
  communication: "Communication",
  content: "Content",
  data: "Data",
  developer: "Developer",
  productivity: "Productivity",
  other: "Other",
};

const SUGGEST_A_CONNECTOR_URL = "https://paperclip.ing/connectors/suggest";
const GENERIC_SLUGS = new Set(["oauth-generic", "api-key-generic"]);

function connectHref(slug: string): string {
  return `/apps/connect/${slug}`;
}

export function Browse() {
  const navigate = useNavigate();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();

  const query = searchParams.get("q") ?? "";
  const category = searchParams.get("category");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Apps", href: "/apps" },
      { label: "Browse" },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const gallery = galleryQuery.data?.apps ?? [];

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  // Category counts (from AppDefinition.categories), ordered by the enum.
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const app of gallery) {
      for (const c of app.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return Object.keys(CATEGORY_LABELS)
      .filter((c) => counts.has(c))
      .map((c) => ({ key: c, label: CATEGORY_LABELS[c], count: counts.get(c)! }));
  }, [gallery]);

  const escapeHatches = useMemo(() => gallery.filter((a) => GENERIC_SLUGS.has(a.slug)), [gallery]);
  const featured = useMemo(
    () => gallery.filter((a) => a.featured && !GENERIC_SLUGS.has(a.slug)),
    [gallery],
  );

  const trimmed = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    return gallery.filter((app) => {
      if (GENERIC_SLUGS.has(app.slug)) return false; // pinned separately
      if (category && !app.categories.includes(category as AppDefinition["categories"][number])) return false;
      if (!trimmed) return true;
      return (
        app.name.toLowerCase().includes(trimmed) ||
        app.slug.includes(trimmed) ||
        app.description.toLowerCase().includes(trimmed) ||
        app.categories.some((c) => c.includes(trimmed))
      );
    });
  }, [gallery, trimmed, category]);

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to browse apps.</div>;
  }

  const loading = galleryQuery.isLoading;
  const showFeatured = !trimmed && !category && featured.length > 0;

  return (
    <div className="max-w-6xl pb-12">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Browse</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect an app so your agents can use its tools.
        </p>
      </header>

      <div className="relative mb-6 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(event) => setParam("q", event.target.value || null)}
          placeholder="Search by name or URL"
          aria-label="Search apps"
          className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/30"
        />
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Category rail */}
        <nav className="shrink-0 lg:w-48" aria-label="Categories">
          <ul className="flex flex-wrap gap-1 lg:flex-col">
            <CategoryRow
              label="All"
              count={gallery.filter((a) => !GENERIC_SLUGS.has(a.slug)).length}
              active={!category}
              onClick={() => setParam("category", null)}
            />
            {categoryCounts.map((c) => (
              <CategoryRow
                key={c.key}
                label={c.label}
                count={c.count}
                active={category === c.key}
                onClick={() => setParam("category", c.key)}
              />
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1 space-y-8">
          {/* Escape hatches, pinned */}
          {!loading && escapeHatches.length > 0 && !category && !trimmed && (
            <section className="grid gap-3 sm:grid-cols-2">
              {escapeHatches.map((app) => (
                <EscapeHatchCard key={app.slug} app={app} onClick={() => navigate(connectHref(app.slug))} />
              ))}
            </section>
          )}

          {loading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full rounded-xl" />
              ))}
            </div>
          ) : (
            <>
              {showFeatured && (
                <Section title="Featured">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {featured.map((app) => (
                      <AppTile key={app.slug} app={app} onClick={() => navigate(connectHref(app.slug))} />
                    ))}
                  </div>
                </Section>
              )}

              <Section title={trimmed ? `Results (${filtered.length})` : category ? CATEGORY_LABELS[category] ?? "Apps" : "All apps"}>
                {filtered.length === 0 ? (
                  <SuggestConnectorCard emptyQuery={query.trim()} />
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {filtered.map((app) => (
                      <AppTile key={app.slug} app={app} onClick={() => navigate(connectHref(app.slug))} />
                    ))}
                    <SuggestConnectorCard />
                  </div>
                )}
              </Section>

              <div className="flex justify-end">
                <AdvancedToolsLink />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CategoryRow({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
          active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50",
        )}
      >
        <span>{label}</span>
        <span className="text-xs text-muted-foreground">{count}</span>
      </button>
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </section>
  );
}

function AppTile({ app, onClick }: { app: AppDefinition; onClick: () => void }) {
  const method = getAvailableConnectionMethod(app);
  const limited = app.availability?.available === false;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-full items-start gap-3 rounded-xl border border-border bg-card px-4 py-4 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40"
    >
      <AppLogo name={app.name} logoUrl={app.branding.logoUrl} size={36} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">{app.name}</div>
        <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{app.description}</div>
        <div className="mt-1.5 flex items-center gap-1.5">
          {method && <MethodBadges method={method} />}
          {limited && (
            <span className="text-(length:--text-nano) font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
              Limited
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function EscapeHatchCard({ app, onClick }: { app: AppDefinition; onClick: () => void }) {
  const isOAuth = app.slug === "oauth-generic";
  const Icon = isOAuth ? ShieldCheck : KeyRound;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-3 rounded-xl border border-dashed border-border bg-card px-4 py-4 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">{app.name}</div>
        <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{app.description}</div>
      </div>
    </button>
  );
}

function SuggestConnectorCard({ emptyQuery }: { emptyQuery?: string }) {
  return (
    <a
      href={SUGGEST_A_CONNECTOR_URL}
      target="_blank"
      rel="noreferrer"
      className="flex h-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center transition-colors hover:border-foreground/30 hover:bg-accent/40"
    >
      <Sparkles className="h-5 w-5 text-muted-foreground" />
      <span className="text-sm font-medium text-foreground">
        {emptyQuery ? `No connectors match “${emptyQuery}”` : "Don’t see it?"}
      </span>
      <span className="text-xs text-primary">Suggest a connector →</span>
    </a>
  );
}
