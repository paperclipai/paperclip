import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link2, Search } from "lucide-react";
import type { AppGalleryEntry } from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { Skeleton } from "@/components/ui/skeleton";
import { AppLogo } from "./AppLogo";
import { AdvancedToolsLink, BYO_CONNECT_HREF, ByoConnectCard, POPULAR_KEYS } from "./store-cards";

/**
 * Door 1 — Browse (the store) (PAP-13254 / U3 §4).
 *
 * A persistent, browsable storefront: search + a Popular grid + the full
 * gallery + a first-class bring-your-own card + a labelled Developer link.
 * Splitting the store out of the connected-instances table (now the
 * Connections door) fixes F1 — users can see what's addable without committing
 * to the Connect wizard. Selecting any tile opens the existing guided wizard.
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

  const connect = () => navigate("/apps/connect");
  const loading = galleryQuery.isLoading;

  return (
    <div className="max-w-5xl space-y-8 pb-12">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Browse</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Browse tools your agents can use. Connecting one takes about a minute.
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
                  <AppTile key={entry.key} entry={entry} onConnect={connect} compact />
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
                No apps match “{query.trim()}”. You can still connect any tool by pasting its link.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((entry) => (
                  <AppTile key={entry.key} entry={entry} onConnect={connect} />
                ))}
              </div>
            )}
          </section>

          <ByoConnectCard onConnect={() => navigate(BYO_CONNECT_HREF)} />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Apps you connect become available to every agent unless you change “Who can use it”.
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
  entry: AppGalleryEntry;
  onConnect: () => void;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <button
        type="button"
        onClick={onConnect}
        className="flex flex-col items-center gap-2 rounded-xl border border-border bg-background px-3 py-4 text-center transition-colors hover:border-foreground/30 hover:bg-accent/40"
      >
        <AppLogo name={entry.name} logoUrl={entry.logoUrl} size={36} />
        <span className="text-xs font-medium text-foreground">{entry.name}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onConnect}
      className="flex h-full items-start gap-3 rounded-xl border border-border bg-card px-4 py-4 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40"
    >
      <AppLogo name={entry.name} logoUrl={entry.logoUrl} size={36} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">{entry.name}</div>
        <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{entry.tagline}</div>
      </div>
      <span className="shrink-0 text-xs font-semibold text-primary">Connect →</span>
    </button>
  );
}
