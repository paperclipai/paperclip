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
  POPULAR_KEYS,
  ZAPIER_CONNECT_HREF,
} from "./store-cards";

/**
 * Door 1 — Browse (the store) (PAP-13254 / U3 §4).
 *
 * A persistent, browsable storefront: search + a Popular grid + the full
 * gallery + a first-class bring-your-own card + a labelled Developer link.
 * Browse remains the single discoverability surface. Zapier and bring-your-own
 * MCP servers use the URL flow; the remaining integrations stay unavailable.
 */
export function Browse() {
  const navigate = useNavigate();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [query, setQuery] = useState("");

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

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to browse apps.</div>;
  }

  const loading = galleryQuery.isLoading;

  return (
    <div className="max-w-5xl space-y-8 pb-12">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Browse</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect Zapier or your own MCP server. More integrations are coming soon.
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
                    onConnect={appDefinitionSlug(entry) === "zapier" ? () => navigate(ZAPIER_CONNECT_HREF) : undefined}
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
                    onConnect={appDefinitionSlug(entry) === "zapier" ? () => navigate(ZAPIER_CONNECT_HREF) : undefined}
                  />
                ))}
              </div>
            )}
          </section>

          <ByoConnectCard onConnect={() => navigate(BYO_CONNECT_HREF)} />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Zapier connects with the MCP URL it gives you. Other listed integrations are previews.
            </p>
            <AdvancedToolsLink />
          </div>
        </>
      )}
    </div>
  );
}

function AppTile({
  entry,
  onConnect,
  compact = false,
}: {
  entry: AppGalleryDisplayEntry;
  onConnect?: () => void;
  compact?: boolean;
}) {
  const disabled = !onConnect;
  if (compact) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onConnect}
        className={disabled
          ? "flex cursor-not-allowed flex-col items-center gap-2 rounded-xl border border-border bg-background px-3 py-4 text-center opacity-60"
          : "flex flex-col items-center gap-2 rounded-xl border border-border bg-background px-3 py-4 text-center transition-colors hover:border-foreground/30 hover:bg-accent/40"}
      >
        <AppLogo name={appDefinitionName(entry)} logoUrl={appDefinitionLogoUrl(entry)} size={36} />
        <span className="text-xs font-medium text-foreground">{appDefinitionName(entry)}</span>
        <span className={disabled ? "text-xs text-muted-foreground" : "text-xs font-semibold text-primary"}>
          {disabled ? "Coming soon" : "Connect →"}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onConnect}
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
        {disabled ? "Coming soon" : "Connect →"}
      </span>
    </button>
  );
}
