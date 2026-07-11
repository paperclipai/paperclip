import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link2, Search } from "lucide-react";
import type { AppGalleryEntry } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { Skeleton } from "@/components/ui/skeleton";
import { AppLogo } from "./AppLogo";
import { AdvancedToolsLink, ByoConnectCard, POPULAR_KEYS } from "./store-cards";

/**
 * Door 1 — Browse (the store) (PAP-13254 / U3 §4).
 *
 * A persistent, browsable storefront: search + a Popular grid + the full
 * gallery + a first-class bring-your-own card + a labelled Developer link.
 * Connection setup is intentionally unavailable until its integrations are
 * ready, so Browse remains the single discoverability surface.
 */
export function Browse() {
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

  const gallery = galleryQuery.data?.apps ?? [];
  const popular = useMemo(
    () =>
      POPULAR_KEYS.map((key) => gallery.find((entry) => entry.key === key)).filter(
        (entry): entry is AppGalleryEntry => Boolean(entry),
      ),
    [gallery],
  );

  const trimmed = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!trimmed) return gallery;
    return gallery.filter(
      (entry) =>
        entry.name.toLowerCase().includes(trimmed) ||
        entry.tagline.toLowerCase().includes(trimmed) ||
        (entry.description?.toLowerCase().includes(trimmed) ?? false),
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
          Browse tools planned for your agents. Connections are coming soon.
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
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Popular
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {popular.map((entry) => (
                  <AppTile key={entry.key} entry={entry} compact />
                ))}
              </div>
            </section>
          )}

          <section className="space-y-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
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
                  <AppTile key={entry.key} entry={entry} />
                ))}
              </div>
            )}
          </section>

          <ByoConnectCard disabled />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              App connections are not available yet. Browse the planned integrations above.
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
  compact = false,
}: {
  entry: AppGalleryEntry;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <button
        type="button"
        disabled
        className="flex cursor-not-allowed flex-col items-center gap-2 rounded-xl border border-border bg-background px-3 py-4 text-center opacity-60"
      >
        <AppLogo name={entry.name} logoUrl={entry.logoUrl} size={36} />
        <span className="text-xs font-medium text-foreground">{entry.name}</span>
        <span className="text-xs text-muted-foreground">Coming soon</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled
      className="flex h-full cursor-not-allowed items-start gap-3 rounded-xl border border-border bg-card px-4 py-4 text-left opacity-60"
    >
      <AppLogo name={entry.name} logoUrl={entry.logoUrl} size={36} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">{entry.name}</div>
        <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{entry.tagline}</div>
      </div>
      <span className="shrink-0 text-xs font-semibold text-muted-foreground">Coming soon</span>
    </button>
  );
}
