import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Link2, Search } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { accessApi } from "@/api/access";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
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
import {
  ConnectionOwnerIdentity,
  connectionDisplayNameForOwner,
  connectionOwnerProfile,
  type ConnectionOwnerProfile,
} from "./connection-owner";

function connectHrefFor(entry: AppGalleryDisplayEntry): string | null {
  const slug = appDefinitionSlug(entry);
  if (slug === "notion") return NOTION_CONNECT_HREF;
  if (slug === "zapier") return ZAPIER_CONNECT_HREF;
  if (slug === "posthog") return "/apps/connect?byo=1&appKey=posthog&stage=setup";
  if (slug === "composio") return "/apps/connect?byo=1&appKey=composio&stage=setup";
  if (slug === "gmail") return "/apps/connect?byo=1&appKey=gmail&stage=access";
  return null;
}

function additionalConnectionHref(
  entry: AppGalleryDisplayEntry,
  applicationId: string,
): string | null {
  const baseHref = connectHrefFor(entry);
  if (!baseHref) return null;
  const [path, rawQuery = ""] = baseHref.split("?");
  const params = new URLSearchParams(rawQuery);
  params.set("applicationId", applicationId);
  params.set("name", appDefinitionName(entry));
  params.set("new", "1");
  return `${path}?${params.toString()}`;
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
  const userDirectoryQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId ?? "__none__"),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
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
    const gallerySlugs = new Set(gallery.map((entry) => appDefinitionSlug(entry)));
    const gallerySlugByName = new Map(
      gallery.map((entry) => [appDefinitionName(entry).trim().toLowerCase(), appDefinitionSlug(entry)]),
    );
    const connectionsByApplicationId = new Map<string, typeof connections>();
    for (const connection of connections) {
      if (connection.status === "archived") continue;
      connectionsByApplicationId.set(
        connection.applicationId,
        [...(connectionsByApplicationId.get(connection.applicationId) ?? []), connection],
      );
    }

    const summaries = new Map<string, {
      applicationId: string;
      count: number;
      primaryConnection: (typeof connections)[number] | null;
    }>();
    for (const application of applicationsQuery.data?.applications ?? []) {
      if (application.status === "archived") continue;
      const appConnections = connectionsByApplicationId.get(application.id) ?? [];
      const configuredConnectionSlug = appConnections
        .map((connection) => connection.config?.sourceTemplateKey ?? connection.transportConfig?.sourceTemplateKey)
        .find((value): value is string => typeof value === "string" && gallerySlugs.has(value));
      const applicationSlug = appApplicationSourceSlug(application);
      const slug = applicationSlug && gallerySlugs.has(applicationSlug)
        ? applicationSlug
        : configuredConnectionSlug
          ?? gallerySlugByName.get(application.name.trim().toLowerCase())
          ?? null;
      if (!slug) continue;
      const current = summaries.get(slug);
      summaries.set(slug, {
        applicationId: current?.applicationId ?? application.id,
        count: (current?.count ?? 0) + appConnections.length,
        primaryConnection: current?.primaryConnection ?? appConnections[0] ?? null,
      });
    }
    return summaries;
  }, [applicationsQuery.data, connectionsQuery.data, gallery]);
  const userProfileById = useMemo(
    () => buildCompanyUserProfileMap(userDirectoryQuery.data?.users),
    [userDirectoryQuery.data],
  );

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select an organization to browse apps.</div>;
  }

  const loading = galleryQuery.isLoading || applicationsQuery.isLoading || connectionsQuery.isLoading;

  const tileProps = (entry: AppGalleryDisplayEntry) => {
    const summary = connectionSummaryBySlug.get(appDefinitionSlug(entry));
    const connectHref = connectHrefFor(entry);
    const available = entry.availability?.available !== false;
    const primaryConnection = summary?.primaryConnection ?? null;
    const owner = primaryConnection ? connectionOwnerProfile(primaryConnection, userProfileById) : null;
    const addAnotherHref = summary
      ? additionalConnectionHref(entry, summary.applicationId)
      : null;
    return {
      connectedCount: summary?.count ?? 0,
      connectionName: primaryConnection
        ? connectionDisplayNameForOwner(primaryConnection, appDefinitionName(entry), owner)
        : null,
      owner,
      onPrimary: primaryConnection
        ? () => navigate(summary && summary.count > 1
            ? `/apps/app/${summary.applicationId}/setup`
            : `/apps/${primaryConnection.id}/setup`)
        : available && connectHref
          ? () => navigate(connectHref)
          : undefined,
      onAddAnother: addAnotherHref ? () => navigate(addAnotherHref) : undefined,
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
  onPrimary,
  onAddAnother,
  connectedCount,
  connectionName,
  owner,
  compact = false,
}: {
  entry: AppGalleryDisplayEntry;
  onPrimary?: () => void;
  onAddAnother?: () => void;
  connectedCount: number;
  connectionName: string | null;
  owner: ConnectionOwnerProfile | null;
  compact?: boolean;
}) {
  const disabled = !onPrimary;
  const connected = connectedCount > 0;
  const appName = appDefinitionName(entry);
  const actionLabel = connected
    ? connectedCount > 1 ? "Edit connections" : "Edit connection"
    : disabled ? "Coming soon" : "Connect";
  const connectedActionClass = connected
    ? "border-emerald-500/50 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"
    : undefined;
  if (compact) {
    return (
      <div
        className={disabled
          ? "flex cursor-not-allowed flex-col items-center gap-2 rounded-xl border border-border bg-background px-3 py-4 text-center opacity-60"
          : "flex flex-col items-center gap-2 rounded-xl border border-border bg-background px-3 py-4 text-center"}
      >
        <AppLogo name={appName} logoUrl={appDefinitionLogoUrl(entry)} size={36} />
        <span className="text-xs font-medium text-foreground">{appName}</span>
        {connected && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            <Check className="h-3 w-3" /> {connectedCount} connected
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={onPrimary}
          className={connectedActionClass}
          aria-label={`${actionLabel} for ${appName}`}
        >
          {actionLabel}
        </Button>
        {connected && onAddAnother && (
          <button
            type="button"
            onClick={onAddAnother}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`Add another ${appName} account`}
          >
            Add new
          </button>
        )}
      </div>
    );
  }
  return (
    <div
      className={disabled
        ? "flex h-full cursor-not-allowed items-start gap-3 rounded-xl border border-border bg-card px-4 py-4 text-left opacity-60"
        : "flex h-full items-start gap-3 rounded-xl border border-border bg-card px-4 py-4 text-left"}
    >
      <AppLogo name={appName} logoUrl={appDefinitionLogoUrl(entry)} size={36} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">{appName}</div>
        <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{appDefinitionDescription(entry)}</div>
        {connected && owner && (
          <div className="mt-2">
            <ConnectionOwnerIdentity owner={owner} />
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {connected && connectionName && (
          <span className="max-w-40 truncate text-xs text-muted-foreground">{connectionName}</span>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={onPrimary}
          className={connectedActionClass}
          aria-label={`${actionLabel} for ${appName}`}
        >
          {actionLabel}
        </Button>
        {connected && onAddAnother && (
          <button
            type="button"
            onClick={onAddAnother}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`Add another ${appName} account`}
          >
            Add new
          </button>
        )}
      </div>
    </div>
  );
}
