import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link2, Search } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { Skeleton } from "@/components/ui/skeleton";
import { AppLogo } from "./AppLogo";
import {
  appApplicationSourceSlug,
  appDefinitionDescription,
  appDefinitionLogoUrl,
  appDefinitionName,
  appDefinitionSlug,
  type AppGalleryDisplayEntry,
} from "./app-definition-display";
import {
  AdvancedToolsLink,
  BYO_CONNECT_HREF,
  ByoConnectCard,
  NOTION_CONNECT_HREF,
  POPULAR_KEYS,
  ZAPIER_CONNECT_HREF,
} from "./store-cards";

function connectHrefFor(entry: AppGalleryDisplayEntry): string | null {
  const slug = appDefinitionSlug(entry);
  if (slug === "notion") return NOTION_CONNECT_HREF;
  if (slug === "zapier") return ZAPIER_CONNECT_HREF;
  if (slug === "posthog") return "/apps/connect?byo=1&appKey=posthog&stage=setup";
  return null;
}

/**
 * Door 1 — Browse (the store) (PAP-13254 / U3 §4).
 *
 * A persistent, browsable storefront: search + a Popular grid + the full
 * gallery + a first-class bring-your-own card + a labelled Developer link.
 * Browse remains the single discoverability surface. Notion uses MCP-direct
 * OAuth, while Zapier and bring-your-own MCP servers use the URL flow.
 */
export function Browse() {
  const navigate = useNavigate();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [query, setQuery] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Organization", href: "/dashboard" },
      { label: "Apps" },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const applicationsQuery = useQuery({
    queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listApplications(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listConnections(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const gallery = (galleryQuery.data?.apps ?? []) as AppGalleryDisplayEntry[];
  const popular = useMemo(
    () =>
      POPULAR_KEYS.map((key) => gallery.find((entry) => appDefinitionSlug(entry) === key)).filter(
        (entry): entry is AppGalleryDisplayEntry => Boolean(entry),
      ),
    [gallery],
  );

  const trimmed = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!trimmed) return gallery;
    return gallery.filter(
      (entry) =>
        appDefinitionName(entry).toLowerCase().includes(trimmed) ||
        appDefinitionDescription(entry).toLowerCase().includes(trimmed),
    );
  }, [gallery, trimmed]);
  const connectionSummaryBySlug = useMemo(() => {
    const connections = connectionsQuery.data?.connections ?? [];
    const connectedCountByApplicationId = new Map<string, number>();
    for (const connection of connections) {
      if (connection.status === "archived" || connection.status === "draft") continue;
      connectedCountByApplicationId.set(
        connection.applicationId,
        (connectedCountByApplicationId.get(connection.applicationId) ?? 0) + 1,
      );
    }

    const summaries = new Map<string, { applicationId: string; count: number }>();
    for (const application of applicationsQuery.data?.applications ?? []) {
      if (application.status === "archived") continue;
      const slug = appApplicationSourceSlug(application);
      if (!slug) continue;
      const count = connectedCountByApplicationId.get(application.id) ?? 0;
      const current = summaries.get(slug);
      summaries.set(slug, {
        applicationId: current?.applicationId ?? application.id,
        count: (current?.count ?? 0) + count,
      });
    }
    return summaries;
  }, [applicationsQuery.data, connectionsQuery.data]);

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select an organization to browse apps.</div>;
  }

  const loading = galleryQuery.isLoading || applicationsQuery.isLoading || connectionsQuery.isLoading;

  const tileProps = (entry: AppGalleryDisplayEntry) => {
    const summary = connectionSummaryBySlug.get(appDefinitionSlug(entry));
    const connectHref = connectHrefFor(entry);
    return {
      connectedCount: summary?.count ?? 0,
      onOpen: summary && summary.count > 0
        ? () => navigate(`/apps/app/${summary.applicationId}/setup`)
        : connectHref
          ? () => navigate(connectHref)
          : undefined,
    };
  };

  return (
    <div className="max-w-5xl space-y-8 pb-12">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Browse</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose an app or connect your own MCP server.
        </p>
      </header>

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search apps…"
          aria-label="Search apps"
          className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/30"
        />
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          {!trimmed && popular.length > 0 && (
            <section className="space-y-3">
              <div className="text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                Popular
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {popular.map((entry) => (
                  <AppTile
                    key={appDefinitionSlug(entry)}
                    entry={entry}
                    {...tileProps(entry)}
                    compact
                  />
                ))}
              </div>
            </section>
          )}

          <section className="space-y-3">
            <div className="text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
              {trimmed ? `Results (${filtered.length})` : "All apps"}
            </div>
            {filtered.length === 0 ? (
              <p className="flex items-center gap-1.5 rounded-xl border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
                <Link2 className="h-4 w-4" />
                No planned apps match “{query.trim()}”.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((entry) => (
                  <AppTile
                    key={appDefinitionSlug(entry)}
                    entry={entry}
                    {...tileProps(entry)}
                  />
                ))}
              </div>
            )}
          </section>

          <ByoConnectCard onConnect={() => navigate(BYO_CONNECT_HREF)} />

          <div className="flex justify-end">
            <AdvancedToolsLink />
          </div>
        </>
      )}
    </div>
  );
}

function AppTile({
  entry,
  onOpen,
  connectedCount,
  compact = false,
}: {
  entry: AppGalleryDisplayEntry;
  onOpen?: () => void;
  connectedCount: number;
  compact?: boolean;
}) {
  const disabled = !onOpen;
  const actionLabel = connectedCount > 0
    ? `${connectedCount} connected already`
    : disabled
      ? "Coming soon"
      : "Connect →";
  if (compact) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onOpen}
        className={disabled
          ? "flex cursor-not-allowed flex-col items-center gap-2 rounded-xl border border-border bg-background px-3 py-4 text-center opacity-60"
          : "flex flex-col items-center gap-2 rounded-xl border border-border bg-background px-3 py-4 text-center transition-colors hover:border-foreground/30 hover:bg-accent/40"}
      >
        <AppLogo name={appDefinitionName(entry)} logoUrl={appDefinitionLogoUrl(entry)} size={36} />
        <span className="text-xs font-medium text-foreground">{appDefinitionName(entry)}</span>
        <span className={disabled ? "text-xs text-muted-foreground" : "text-xs font-semibold text-primary"}>
          {actionLabel}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onOpen}
      className={disabled
        ? "flex h-full cursor-not-allowed items-start gap-3 rounded-xl border border-border bg-card px-4 py-4 text-left opacity-60"
        : "flex h-full items-start gap-3 rounded-xl border border-border bg-card px-4 py-4 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40"}
    >
      <AppLogo name={appDefinitionName(entry)} logoUrl={appDefinitionLogoUrl(entry)} size={36} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">{appDefinitionName(entry)}</div>
        <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{appDefinitionDescription(entry)}</div>
      </div>
      <span className={disabled ? "shrink-0 text-xs font-semibold text-muted-foreground" : "shrink-0 text-xs font-semibold text-primary"}>
        {actionLabel}
      </span>
    </button>
  );
}
