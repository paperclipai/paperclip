import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Link2, Search } from "lucide-react";
import {
  appSupportsCatalogSetup,
  getAppDefinitionForUrl,
  getAppStoreDefinition,
} from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";
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
  appDefinitionDarkLogoUrl,
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
} from "./store-cards";
import {
  appSourceConnectHref,
  appSourceResumeHref,
} from "./app-connect-policy";
import {
  ConnectionOwnerIdentity,
  connectionDisplayNameForOwner,
  connectionOwnerProfile,
  type ConnectionOwnerProfile,
} from "./connection-owner";

function connectHrefFor(entry: AppGalleryDisplayEntry): string | null {
  const slug = appDefinitionSlug(entry);
  const definition = getAppStoreDefinition(slug);
  return appSupportsCatalogSetup(definition)
    ? appSourceConnectHref(slug)
    : null;
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
 * A persistent, browsable storefront: search + Popular and Connected grids +
 * the full gallery + a first-class bring-your-own card + a labelled Developer
 * link.
 * Browse remains the single discoverability surface. Capability-backed apps
 * share the curated setup route; Zapier branches to its generated-URL screen.
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
    queryKey: queryKeys.access.companyUserDirectory(
      selectedCompanyId ?? "__none__",
    ),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const gallery = (galleryQuery.data?.apps ?? []) as AppGalleryDisplayEntry[];
  const popular = useMemo(
    () =>
      POPULAR_KEYS.map((key) =>
        gallery.find((entry) => appDefinitionSlug(entry) === key),
      ).filter((entry): entry is AppGalleryDisplayEntry => Boolean(entry)),
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
    const gallerySlugs = new Set(
      gallery.map((entry) => appDefinitionSlug(entry)),
    );
    const gallerySlugByName = new Map(
      gallery.map((entry) => [
        appDefinitionName(entry).trim().toLowerCase(),
        appDefinitionSlug(entry),
      ]),
    );
    const connectionsByApplicationId = new Map<string, typeof connections>();
    for (const connection of connections) {
      if (connection.status === "archived") continue;
      connectionsByApplicationId.set(connection.applicationId, [
        ...(connectionsByApplicationId.get(connection.applicationId) ?? []),
        connection,
      ]);
    }

    const summaries = new Map<
      string,
      {
        applicationId: string;
        connectedCount: number;
        draftCount: number;
        primaryConnection: (typeof connections)[number] | null;
      }
    >();
    for (const application of applicationsQuery.data?.applications ?? []) {
      if (application.status === "archived") continue;
      const appConnections =
        connectionsByApplicationId.get(application.id) ?? [];
      const configuredConnectionSlug = appConnections
        .map(
          (connection) =>
            connection.config?.sourceTemplateKey ??
            connection.transportConfig?.sourceTemplateKey,
        )
        .find(
          (value): value is string =>
            typeof value === "string" && gallerySlugs.has(value),
        );
      // Older branded URL flows (notably Zapier) were persisted as generic
      // `link` applications even though their public endpoint matched a curated
      // provider. Keep those already-working connections attached to the store
      // card without rewriting credentials or relying on a display-name guess.
      const endpointMatchedSlug = appConnections
        .flatMap((connection) => [
          connection.config?.url,
          connection.transportConfig?.url,
        ])
        .map((value) =>
          typeof value === "string"
            ? appDefinitionSlug(getAppDefinitionForUrl(value, gallery)) || null
            : null,
        )
        .find((value): value is string => Boolean(value));
      const applicationSlug = appApplicationSourceSlug(application);
      const slug =
        applicationSlug &&
        applicationSlug !== "link" &&
        gallerySlugs.has(applicationSlug)
          ? applicationSlug
          : (configuredConnectionSlug ??
            endpointMatchedSlug ??
            gallerySlugByName.get(application.name.trim().toLowerCase()) ??
            null);
      if (!slug) continue;
      const current = summaries.get(slug);
      const connectedConnections = appConnections.filter(
        (connection) => connection.status !== "draft",
      );
      const draftConnections = appConnections.filter(
        (connection) => connection.status === "draft",
      );
      summaries.set(slug, {
        applicationId: current?.applicationId ?? application.id,
        connectedCount:
          (current?.connectedCount ?? 0) + connectedConnections.length,
        draftCount: (current?.draftCount ?? 0) + draftConnections.length,
        // Interrupted OAuth attempts remain resumable, but are not successful
        // connections and must not receive the green Connected treatment.
        primaryConnection:
          current?.primaryConnection ??
          connectedConnections[0] ??
          draftConnections[0] ??
          null,
      });
    }
    return summaries;
  }, [applicationsQuery.data, connectionsQuery.data, gallery]);
  const userProfileById = useMemo(
    () => buildCompanyUserProfileMap(userDirectoryQuery.data?.users),
    [userDirectoryQuery.data],
  );
  const sortedPopular = useMemo(
    () =>
      popular
        .map((entry, index) => ({ entry, index }))
        .sort((left, right) => {
          const leftSummary = connectionSummaryBySlug.get(
            appDefinitionSlug(left.entry),
          );
          const rightSummary = connectionSummaryBySlug.get(
            appDefinitionSlug(right.entry),
          );
          const leftRank =
            (leftSummary?.connectedCount ?? 0) > 0
              ? 2
              : (leftSummary?.draftCount ?? 0) > 0
                ? 1
                : 0;
          const rightRank =
            (rightSummary?.connectedCount ?? 0) > 0
              ? 2
              : (rightSummary?.draftCount ?? 0) > 0
                ? 1
                : 0;
          return rightRank - leftRank || left.index - right.index;
        })
        .map(({ entry }) => entry),
    [connectionSummaryBySlug, popular],
  );
  const connectedApps = useMemo(
    () =>
      gallery.filter(
        (entry) =>
          (connectionSummaryBySlug.get(appDefinitionSlug(entry))
            ?.connectedCount ?? 0) > 0,
      ),
    [connectionSummaryBySlug, gallery],
  );
  const sortedFiltered = useMemo(
    () =>
      [...filtered].sort(
        (left, right) =>
          appDefinitionName(left).localeCompare(
            appDefinitionName(right),
            undefined,
            {
              sensitivity: "base",
            },
          ) || appDefinitionSlug(left).localeCompare(appDefinitionSlug(right)),
      ),
    [filtered],
  );

  if (!selectedCompanyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Select an organization to browse apps.
      </div>
    );
  }

  const loading =
    galleryQuery.isLoading ||
    applicationsQuery.isLoading ||
    connectionsQuery.isLoading;

  const tileProps = (entry: AppGalleryDisplayEntry) => {
    const summary = connectionSummaryBySlug.get(appDefinitionSlug(entry));
    const connectHref = connectHrefFor(entry);
    const available = entry.availability?.available !== false;
    const primaryConnection = summary?.primaryConnection ?? null;
    const owner = primaryConnection
      ? connectionOwnerProfile(primaryConnection, userProfileById)
      : null;
    const addAnotherHref =
      summary && summary.connectedCount > 0
        ? additionalConnectionHref(entry, summary.applicationId)
        : null;
    const setupPending =
      (summary?.connectedCount ?? 0) === 0 && (summary?.draftCount ?? 0) > 0;
    return {
      connectedCount: summary?.connectedCount ?? 0,
      setupPending,
      connectionName: primaryConnection
        ? connectionDisplayNameForOwner(
            primaryConnection,
            appDefinitionName(entry),
            owner,
          )
        : null,
      owner,
      onPrimary: primaryConnection
        ? () =>
            navigate(
              setupPending
                ? appSourceResumeHref(
                    appDefinitionSlug(entry),
                    primaryConnection.id,
                  )
                : summary && summary.connectedCount > 1
                  ? `/apps/app/${summary.applicationId}/setup`
                  : `/apps/${primaryConnection.id}/setup`,
            )
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
          {!trimmed && sortedPopular.length > 0 && (
            <section className="space-y-3">
              <div className="text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                Popular
              </div>
              <div
                className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
                aria-label="Popular apps"
              >
                {sortedPopular.map((entry) => (
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

          {!trimmed && connectedApps.length > 0 && (
            <section className="space-y-3">
              <div className="text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                Connected
              </div>
              <div
                className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
                aria-label="Connected apps"
              >
                {connectedApps.map((entry) => (
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
              {trimmed ? `Results (${sortedFiltered.length})` : "All apps"}
            </div>
            {sortedFiltered.length === 0 ? (
              <p className="flex items-center gap-1.5 rounded-xl border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
                <Link2 className="h-4 w-4" />
                No planned apps match “{query.trim()}”.
              </p>
            ) : (
              <div
                className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
                aria-label={trimmed ? "App search results" : "All apps"}
              >
                {sortedFiltered.map((entry) => (
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
  setupPending,
  connectionName,
  owner,
  compact = false,
}: {
  entry: AppGalleryDisplayEntry;
  onPrimary?: () => void;
  onAddAnother?: () => void;
  connectedCount: number;
  setupPending: boolean;
  connectionName: string | null;
  owner: ConnectionOwnerProfile | null;
  compact?: boolean;
}) {
  const disabled = !onPrimary;
  const unavailableReason =
    entry.availability?.available === false
      ? (entry.availability.reason ?? "This app is disabled on this instance.")
      : null;
  const connected = connectedCount > 0;
  const appName = appDefinitionName(entry);
  const actionLabel = connected
    ? connectedCount > 1
      ? "Edit connections"
      : "Edit connection"
    : setupPending
      ? "Finish setup"
      : disabled
        ? "Unavailable"
        : "Connect";
  const connectedActionClass = connected
    ? "border-emerald-500/50 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"
    : undefined;
  if (compact) {
    return (
      <div
        data-app-slug={appDefinitionSlug(entry)}
        data-connected={connected ? "true" : "false"}
        data-setup-pending={setupPending ? "true" : "false"}
        className={
          disabled
            ? "flex h-full min-w-0 cursor-not-allowed flex-col items-center gap-2 rounded-xl border border-border bg-background px-3 py-4 text-center opacity-60"
            : "flex h-full min-w-0 flex-col items-center gap-2 rounded-xl border border-border bg-background px-3 py-4 text-center"
        }
      >
        <AppLogo
          name={appName}
          logoUrl={appDefinitionLogoUrl(entry)}
          darkLogoUrl={appDefinitionDarkLogoUrl(entry)}
          size={36}
        />
        <span className="text-xs font-medium text-foreground">{appName}</span>
        <div
          data-slot="app-tile-status"
          className="flex min-h-4 max-w-full items-center justify-center"
        >
          {connected ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              <Check className="h-3 w-3" /> {connectedCount} connected
            </span>
          ) : setupPending ? (
            <span className="text-xs font-medium text-muted-foreground">
              Setup incomplete
            </span>
          ) : unavailableReason ? (
            <span
              className="truncate text-xs text-muted-foreground"
              title={unavailableReason}
            >
              {unavailableReason}
            </span>
          ) : null}
        </div>
        <div data-slot="app-tile-primary-action" className="w-full min-w-0">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={onPrimary}
            className={cn(
              "w-full max-w-full overflow-hidden text-ellipsis",
              connectedActionClass,
            )}
            aria-label={`${actionLabel} for ${appName}`}
          >
            {actionLabel}
          </Button>
        </div>
        <div
          data-slot="app-tile-secondary-action"
          className="flex min-h-5 items-center justify-center"
        >
          {connected && onAddAnother ? (
            <button
              type="button"
              onClick={onAddAnother}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              aria-label={`Add another ${appName} account`}
            >
              Add new
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div
      data-app-slug={appDefinitionSlug(entry)}
      data-connected={connected ? "true" : "false"}
      data-setup-pending={setupPending ? "true" : "false"}
      className={
        disabled
          ? "flex h-full cursor-not-allowed flex-col rounded-xl border border-border bg-card px-4 py-4 text-left opacity-60"
          : "flex h-full flex-col rounded-xl border border-border bg-card px-4 py-4 text-left"
      }
    >
      <div className="flex items-start gap-3">
        <AppLogo
          name={appName}
          logoUrl={appDefinitionLogoUrl(entry)}
          darkLogoUrl={appDefinitionDarkLogoUrl(entry)}
          size={36}
        />
        <div className="min-w-0 flex-1">
          <div
            data-slot="app-tile-title"
            className="break-words text-sm font-semibold leading-tight text-foreground"
          >
            {appName}
          </div>
          <div
            data-slot="app-tile-header-status"
            className="mt-1 flex min-h-5 items-center"
          >
            {connected && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                <Check className="h-3 w-3" />
                {connectedCount > 1
                  ? `${connectedCount} connected`
                  : "Connected"}
              </span>
            )}
            {setupPending && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                Setup incomplete
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-2 line-clamp-2 text-xs text-muted-foreground">
        {appDefinitionDescription(entry)}
      </div>
      {unavailableReason ? (
        <div className="mt-2 text-xs text-muted-foreground">
          {unavailableReason}
        </div>
      ) : null}
      {connected || setupPending ? (
        <div
          data-slot="app-tile-details"
          className="mt-auto border-t border-border pt-3"
        >
          {connectionName && (
            <div
              data-slot="app-tile-connection-name"
              className="break-words text-sm font-medium text-foreground"
            >
              {connectionName}
            </div>
          )}
          {owner ? (
            <div className="mt-2 min-w-0">
              <ConnectionOwnerIdentity owner={owner} />
            </div>
          ) : null}
          <div
            data-slot="app-tile-actions"
            className="mt-3 flex items-center justify-end gap-2"
          >
            {onAddAnother && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onAddAnother}
                aria-label={`Add another ${appName} account`}
              >
                Add new
              </Button>
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
          </div>
        </div>
      ) : (
        <div
          data-slot="app-tile-actions"
          className="mt-auto flex justify-end pt-3"
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={onPrimary}
            aria-label={`${actionLabel} for ${appName}`}
          >
            {actionLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
