import { useEffect, useRef, useState, type ComponentProps } from "react";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { CONNECTABLE_APP_DEFINITIONS, getAppStoreDefinition, type ToolApplication, type ToolConnection } from "@paperclipai/shared";
import { AGGREGATOR_APP_CATALOG, aggregatorAppIdentity, type AggregatorAppCatalogEntry } from "@paperclipai/shared/aggregator-app-catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CATALOG_PAGE_SIZE, ConnectorCard } from "@/pages/apps/Browse";
import { appCopyFor } from "@/lib/app-gallery-copy";
import { CatalogSourceFilters, CATALOG_SOURCE_NAMES as SOURCE_NAMES, type CatalogSource as Source } from "@/pages/apps/CatalogSourceFilters";

type Row = ComponentProps<typeof ConnectorCard>["row"];
const NATIVE_SLUGS = ["notion", "composio", "agentmail", "arcade", "browser-use-cloud", "discord", "executor", "github", "linear", "posthog", "railway", "slack", "telegram", "zapier"];
const nativeIdentities = new Set(CONNECTABLE_APP_DEFINITIONS.flatMap(app => [app.name, app.slug].map(aggregatorAppIdentity)));
const aggregatorCatalog = AGGREGATOR_APP_CATALOG.filter(app =>
  ![app.name, app.slug, ...app.aliases].some(alias => nativeIdentities.has(aggregatorAppIdentity(alias))));
const PROFILES = new Map([["user-board", { label: "Board", image: null }]]);

function connection(slug: string, name: string): ToolConnection {
  return {
    id: `preview-${slug}`, companyId: "company-storybook", applicationId: `preview-app-${slug}`,
    uid: `preview-${slug}`, name, connectionKind: "managed", connectionPurpose: "tool", ownership: "customer",
    transport: "mcp_remote", authKind: "oauth", credentialSource: "paperclip_vault", credentialPolicy: "shared",
    status: "active", enabled: true, config: { sourceTemplateKey: slug }, transportConfig: {}, credentialSecretRefs: [],
    healthStatus: "ok", healthCheckedAt: new Date(), lastError: null, createdByAgentId: null,
    createdByUserId: "user-board", createdAt: new Date(), updatedAt: new Date(),
  };
}

const NOTION = connection("notion", "Team workspace");
const COMPOSIO = connection("composio", "Work Composio");
const ARCADE = connection("arcade", "Work Arcade");
const EXECUTOR = { ...connection("executor", "Team Executor"), config: { sourceTemplateKey: "executor", managementUrl: "https://executor.sh/team/integrations" } };
const CONNECTIONS = new Map([NOTION, COMPOSIO, ARCADE, EXECUTOR].map(item => [item.id, item]));

function nativeRows(): Row[] {
  return NATIVE_SLUGS.flatMap(slug => {
    const entry = getAppStoreDefinition(slug);
    if (!entry) return [];
    const saved = slug === "notion" ? NOTION : slug === "composio" ? COMPOSIO : slug === "arcade" ? ARCADE : slug === "executor" ? EXECUTOR : null;
    const application: ToolApplication = {
      id: `preview-app-${slug}`, companyId: "company-storybook", name: entry.name,
      description: entry.description, type: "mcp_http", status: "active", pluginId: null,
      ownerAgentId: null, ownerUserId: null, metadata: { sourceTemplateKey: slug },
      archivedAt: null, createdAt: new Date(), updatedAt: new Date(),
    };
    return [{ key: `native:${slug}`, slug, name: entry.name, description: slug === "composio" || slug === "arcade" ? `Connect apps through ${entry.name}.` : appCopyFor(slug).tagline,
      brandKey: slug, entry, connections: saved ? [saved] : [],
      upstreamCatalogApp: slug === "notion" ? AGGREGATOR_APP_CATALOG.find(app => app.slug === "notion") : undefined,
      upstreamApps: slug === "notion" ? [COMPOSIO, ARCADE, EXECUTOR].map(gateway => ({ provider: gateway.config!.sourceTemplateKey as "composio" | "arcade" | "executor", appSlug: "notion", appName: "Notion", connectionId: gateway.id, toolkit: "notion", status: "connected" as const, checkedAt: new Date().toISOString(), accounts: (gateway === ARCADE ? ["Work", "Personal"] : ["Work"]).map(alias => ({ id: `${gateway.id}-${alias}`, alias, status: "ACTIVE", isDefault: false, managementUrl: gateway === EXECUTOR ? EXECUTOR.config.managementUrl : undefined })) })) : undefined,
      applications: saved ? [application] : [], chatEndpoints: [], logoUrl: entry.branding?.logoUrl, darkLogoUrl: entry.branding?.darkLogoUrl }];
  });
}

function aggregatorRow(app: AggregatorAppCatalogEntry, source: Source): Row {
  const routes = app.routes.filter(route => source === "all" || route.provider === source);
  const scopedApp = { ...app, routes };
  const connected = aggregatorAppIdentity(app.name) === "circleback" && routes.some(route => route.provider === "composio");
  return {
    key: `aggregator:${app.slug}`, slug: app.slug, name: app.name,
    description: `Connect through ${routes.map(route => SOURCE_NAMES[route.provider]).join(" or ")}.`,
    brandKey: app.slug, logoUrl: routes[0]?.logoUrl, entry: null, applications: [], connections: [], chatEndpoints: [],
    aggregatorApp: scopedApp, upstreamCatalogApp: scopedApp,
    upstreamApps: connected ? [{ connectionId: COMPOSIO.id, toolkit: "circleback_mcp", status: "connected",
      checkedAt: new Date().toISOString(), accounts: [{ id: "preview-circleback", alias: "Meeting notes", status: "ACTIVE", isDefault: true }] }] : [],
  };
}

function installed(row: Row) {
  return row.connections.length > 0 || Boolean(row.upstreamApps?.some(app => app.accounts.length > 0));
}

/** Design review only: real public catalogs and shipped cards, with local example accounts. */
export function ConnectorCatalogNavigation({
  initialSource = "paperclip", initialQuery = "", initialPage = 1, pageSize = CATALOG_PAGE_SIZE,
}: { initialSource?: Source; initialQuery?: string; initialPage?: number; pageSize?: number }) {
  const expandsInitialSearch = Boolean(initialQuery.trim() && initialSource === "paperclip");
  const [source, setSource] = useState<Source>(expandsInitialSearch ? "all" : initialSource);
  const [expandedSearch, setExpandedSearch] = useState(expandsInitialSearch);
  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState(initialPage);
  const [previewAction, setPreviewAction] = useState<string | null>(null);
  const headerRef = useRef<HTMLElement>(null);
  const availableRef = useRef<HTMLElement>(null);
  const provider = ["composio", "arcade", "executor"].includes(source);
  const native = nativeRows().filter(row => !provider || row.slug === source && installed(row) || row.upstreamApps?.some(app => app.provider === source && app.accounts.length > 0));
  // Saved apps stay visible above discovery, including apps managed through Composio.
  const aggregate = aggregatorCatalog
    .filter(app => source === "paperclip" ? aggregatorAppIdentity(app.name) === "circleback"
      : !provider || app.routes.some(route => route.provider === source))
    .map(app => aggregatorRow(app, provider ? source : "all"));
  const term = query.trim().toLocaleLowerCase();
  const matching = [...native, ...aggregate].filter(row =>
    (source !== "installed" || installed(row)) && (!term || [row.name, row.slug, row.description,
      ...row.connections.map(item => item.name),
      ...(row.upstreamApps?.flatMap(app => app.accounts.map(account => account.alias)) ?? []),
      ...(row.aggregatorApp?.aliases ?? [])].join(" ").toLocaleLowerCase().includes(term)));
  const connected = matching.filter(installed).sort((a, b) => Number(Boolean(a.aggregatorApp)) - Number(Boolean(b.aggregatorApp)) || a.name.localeCompare(b.name));
  const available = matching.filter(row => !installed(row)).sort((a, b) => a.name.localeCompare(b.name));
  const pageCount = Math.max(1, Math.ceil(available.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = available.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => { headerRef.current?.scrollIntoView({ block: "start" }); }, [source]);

  function changePage(next: number) {
    setPage(next);
    requestAnimationFrame(() => availableRef.current?.scrollIntoView({ block: "start" }));
  }

  function browse(next: Source) {
    setSource(next);
    setExpandedSearch(false);
    setPage(1);
  }

  function changeQuery(value: string) {
    // A search from Paperclip includes aggregator apps; explicit filters stay scoped.
    if (source === "paperclip" && !query.trim() && value.trim()) {
      setSource("all");
      setExpandedSearch(true);
    }
    if (expandedSearch && !value.trim()) {
      setSource("paperclip");
      setExpandedSearch(false);
    }
    setQuery(value);
    setPage(1);
  }

  function renderRow(row: Row) {
    return <ConnectorCard key={row.key} row={row} userProfileById={PROFILES} connectionById={CONNECTIONS}
      chatConnectorsEnabled onNavigate={() => setPreviewAction(row.name)}
      onRequestRemove={target => setPreviewAction(target.accountName)}
      onConnectAggregator={app => setPreviewAction(app.name)} onManageAggregator={app => setPreviewAction(app.name)}
      onRefreshAggregator={id => setPreviewAction(`Refresh ${CONNECTIONS.get(id)?.config?.sourceTemplateKey}`)} aggregatorRefreshState={new Map([COMPOSIO, ARCADE, EXECUTOR].map(gateway => [gateway.id, false]))} />;
  }

  return <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-6">
    <header ref={headerRef} className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Connectors</h1>
      <div className="relative min-w-0">
        <Search aria-hidden className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="Search connectors" placeholder={provider ? `Search ${SOURCE_NAMES[source]} apps…` : source === "installed" ? "Search installed apps…" : "Search all connectors…"}
          value={query} onChange={event => changeQuery(event.target.value)} className="pl-9 pr-9" />
        {query ? <button aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground"
          onClick={() => changeQuery("")}><X className="size-4" /></button> : null}
      </div>
      <CatalogSourceFilters source={source} onChange={browse} />
    </header>

    {connected.length > 0 ? <section aria-label="Connected apps" className="flex flex-col gap-3">
      <h2 className="text-xs font-medium text-muted-foreground">{source === "installed" ? "Installed" : "Connected"}</h2>
      <div role="list" aria-label="Connected connectors" className="flex flex-col gap-3">{connected.map(renderRow)}</div>
    </section> : null}

    {(available.length > 0 || connected.length === 0) ? <section ref={availableRef} aria-label="Available apps" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium text-muted-foreground">{term ? "Search results" : source === "paperclip" ? "Built into Paperclip" : provider ? `${SOURCE_NAMES[source]} apps` : source === "installed" ? "Installed" : "Available apps"}</h2>
        <span className="text-xs text-muted-foreground" role="status">{available.length.toLocaleString("en-US")} {term ? available.length === 1 ? "result" : "results" : "apps"}</span>
      </div>
      {pageRows.length ? <div role="list" aria-label="Available connectors" className="flex flex-col gap-3">{pageRows.map(renderRow)}</div>
        : <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border p-6">
          <p className="text-sm text-muted-foreground">{source === "installed" ? `No installed apps match “${query.trim()}”.` : `No ${provider ? `${SOURCE_NAMES[source]} ` : ""}apps match “${query.trim()}”.`}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => changeQuery("")}>Clear search</Button>
            {source !== "all" ? <Button variant="ghost" size="sm" onClick={() => browse("all")}>Search all apps</Button> : null}
          </div>
        </div>}
      {pageCount > 1 ? <nav aria-label="Catalog pages" className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{((currentPage - 1) * pageSize + 1).toLocaleString("en-US")}–{Math.min(currentPage * pageSize, available.length).toLocaleString("en-US")} of {available.length.toLocaleString("en-US")}</span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={currentPage === 1} onClick={() => changePage(currentPage - 1)} aria-label="Previous page"><ChevronLeft className="size-4" />Previous</Button>
          <span className="text-xs text-muted-foreground">{currentPage} / {pageCount}</span>
          <Button variant="outline" size="sm" disabled={currentPage === pageCount} onClick={() => changePage(currentPage + 1)} aria-label="Next page">Next<ChevronRight className="size-4" /></Button>
        </div>
      </nav> : null}
    </section> : null}

    <Dialog open={Boolean(previewAction)} onOpenChange={open => !open && setPreviewAction(null)}>
      <DialogContent><DialogHeader><DialogTitle>{previewAction}</DialogTitle>
        <DialogDescription>This preview covers catalog navigation. Account setup and management continue on the Apps page.</DialogDescription>
      </DialogHeader><Button variant="outline" onClick={() => setPreviewAction(null)}>Back to catalog</Button></DialogContent>
    </Dialog>
  </main>;
}
