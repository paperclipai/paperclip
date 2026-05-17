import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentCapabilityConfig,
  AgentCapabilityConfigInput,
  AgentCapabilityMcpServer,
  AgentCapabilitySettingsResponse,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { CapabilityMarketplacePanel } from "./CapabilityMarketplacePanel";
import { CustomMcpServerForm } from "./CustomMcpServerForm";

function formatConfig(config: AgentCapabilityConfig | AgentCapabilityConfigInput) {
  return JSON.stringify(config, null, 2);
}

function emptyConfig(): AgentCapabilityConfigInput {
  return {
    version: 1,
    mcpServers: [],
    skillRefs: [],
    toolRefs: [],
    liveApply: false,
    liveExternalActions: false,
  };
}

function parseDraft(draft: string): { config: AgentCapabilityConfigInput | null; error: string | null } {
  try {
    const value = JSON.parse(draft) as AgentCapabilityConfigInput;
    return { config: value, error: null };
  } catch (error) {
    return { config: null, error: error instanceof Error ? error.message : "Invalid JSON" };
  }
}

function summarize(settings: AgentCapabilitySettingsResponse | undefined) {
  const config = settings?.config;
  return {
    mcpServerCount: config?.mcpServers.length ?? 0,
    skillRefCount: config?.skillRefs.length ?? 0,
    toolRefCount: config?.toolRefs.length ?? 0,
  };
}

// LET-281 Effective Preview inheritance: per-category fallback.
// For each of mcpServers / skillRefs / toolRefs, if the agent-local config
// has any entries for that category we treat local as authoritative for that
// category only. Untouched categories fall back to the global default for
// that category. liveApply and liveExternalActions are always forced to false
// in the preview because the preview is read-only and must never represent a
// live-apply intent.
type EffectiveCategorySource = "local" | "global" | "empty";

function mergeCategory<T>(localList: readonly T[] | undefined, globalList: readonly T[] | undefined): T[] {
  if (localList && localList.length > 0) return [...localList];
  return [...(globalList ?? [])];
}

function describeCategorySource(
  localList: readonly unknown[] | undefined,
  globalList: readonly unknown[] | undefined,
): EffectiveCategorySource {
  if (localList && localList.length > 0) return "local";
  if (globalList && globalList.length > 0) return "global";
  return "empty";
}

function summarizeEffectiveSources(sources: {
  mcp: EffectiveCategorySource;
  skills: EffectiveCategorySource;
  tools: EffectiveCategorySource;
}): string {
  const buckets: Record<EffectiveCategorySource, string[]> = { local: [], global: [], empty: [] };
  buckets[sources.mcp].push("MCP");
  buckets[sources.skills].push("skills");
  buckets[sources.tools].push("tools");
  const parts: string[] = [];
  if (buckets.local.length > 0) parts.push(`${buckets.local.join("/")} from agent local`);
  if (buckets.global.length > 0) parts.push(`${buckets.global.join("/")} from global defaults`);
  if (parts.length === 0) return "no configured capabilities";
  return parts.join("; ");
}

function resolveEffectiveConfig(
  localSettings: AgentCapabilitySettingsResponse | undefined,
  globalSettings: AgentCapabilitySettingsResponse | undefined,
) {
  const localConfig = localSettings?.config;
  const globalConfig = globalSettings?.config;
  const effective = {
    version: 1 as const,
    mcpServers: mergeCategory(localConfig?.mcpServers, globalConfig?.mcpServers),
    skillRefs: mergeCategory(localConfig?.skillRefs, globalConfig?.skillRefs),
    toolRefs: mergeCategory(localConfig?.toolRefs, globalConfig?.toolRefs),
    liveApply: false as const,
    liveExternalActions: false as const,
  };
  const sources = {
    mcp: describeCategorySource(localConfig?.mcpServers, globalConfig?.mcpServers),
    skills: describeCategorySource(localConfig?.skillRefs, globalConfig?.skillRefs),
    tools: describeCategorySource(localConfig?.toolRefs, globalConfig?.toolRefs),
  };
  return { effective, sources, sourceSummary: summarizeEffectiveSources(sources) };
}

function withPaperclipPreset(settings: AgentCapabilitySettingsResponse | undefined, draft: string): AgentCapabilityConfigInput {
  const parsed = parseDraft(draft).config ?? settings?.config ?? emptyConfig();
  const existingServers = Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [];
  if (existingServers.some((server) => server.id === "paperclip-local")) return parsed;
  return {
    ...parsed,
    mcpServers: [
      ...existingServers,
      {
        id: "paperclip-local",
        provider: "manual",
        displayName: "Paperclip MCP",
        transport: "stdio",
        command: "npx -y @paperclipai/mcp-server",
        requiredSecretNames: ["PAPERCLIP_API_KEY"],
        desiredState: "enabled",
        liveState: "not_installed",
      },
    ],
    liveApply: false,
    liveExternalActions: false,
  };
}

function withMarketplaceMcpServer(
  settings: AgentCapabilitySettingsResponse | undefined,
  draft: string,
  server: AgentCapabilityMcpServer,
): AgentCapabilityConfigInput {
  const parsed = parseDraft(draft).config ?? settings?.config ?? emptyConfig();
  const existingServers = Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [];
  const filtered = existingServers.filter((existing) => existing.id !== server.id);
  return {
    ...parsed,
    mcpServers: [...filtered, server],
    liveApply: false,
    liveExternalActions: false,
  };
}

function withoutMarketplaceMcpServer(
  settings: AgentCapabilitySettingsResponse | undefined,
  draft: string,
  serverId: string,
): AgentCapabilityConfigInput {
  const parsed = parseDraft(draft).config ?? settings?.config ?? emptyConfig();
  const existingServers = Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [];
  return {
    ...parsed,
    mcpServers: existingServers.filter((existing) => existing.id !== serverId),
    liveApply: false,
    liveExternalActions: false,
  };
}

type WorkspaceTab = "summary" | "marketplace" | "custom" | "effective";

const workspaceTabs: { key: WorkspaceTab; label: string }[] = [
  { key: "summary", label: "Summary" },
  { key: "marketplace", label: "Marketplace" },
  { key: "custom", label: "Custom" },
  { key: "effective", label: "Effective Preview" },
];

function CapabilitySettingsCard({
  title,
  description,
  queryKey,
  queryFn,
  updateFn,
  enabled = true,
  emptyText = "No desired MCP servers saved yet.",
  effectivePreviewSettings,
  showEffectivePreview = false,
}: {
  title: string;
  description: string;
  queryKey: readonly unknown[];
  queryFn: () => Promise<AgentCapabilitySettingsResponse>;
  updateFn: (config: AgentCapabilityConfigInput) => Promise<AgentCapabilitySettingsResponse>;
  enabled?: boolean;
  emptyText?: string;
  effectivePreviewSettings?: AgentCapabilitySettingsResponse | undefined;
  showEffectivePreview?: boolean;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("summary");

  const capabilitiesQuery = useQuery({
    queryKey,
    queryFn,
    enabled,
  });

  useEffect(() => {
    if (capabilitiesQuery.data) {
      setDraft(formatConfig(capabilitiesQuery.data.config));
      setClientError(null);
    }
  }, [capabilitiesQuery.data]);

  const saveMutation = useMutation({
    mutationFn: updateFn,
    onSuccess: async (settings) => {
      setDraft(formatConfig(settings.config));
      setClientError(null);
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const summary = summarize(capabilitiesQuery.data);
  const parsedDraft = useMemo(() => (draft ? parseDraft(draft) : { config: null, error: null }), [draft]);
  const saveDisabled = saveMutation.isPending || Boolean(parsedDraft.error) || !draft.trim();
  const existingDraftMcpServerIds = useMemo(() => {
    const ids = new Set<string>();
    // Guard against malformed Advanced JSON where mcpServers is not an array
    // (e.g. user typed an object or null). Keep the Advanced JSON fallback
    // editable rather than crashing the render.
    const draftServers = parsedDraft.config?.mcpServers;
    const savedServers = capabilitiesQuery.data?.config.mcpServers;
    const source = Array.isArray(draftServers)
      ? draftServers
      : Array.isArray(savedServers)
        ? savedServers
        : [];
    for (const server of source) {
      if (server?.id) ids.add(server.id);
    }
    return ids;
  }, [parsedDraft.config, capabilitiesQuery.data]);

  if (capabilitiesQuery.isLoading) {
    return (
      <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground" role="status">
        Loading capability workspace… No live MCP install, connect, execute, or external action occurred.
      </div>
    );
  }

  if (capabilitiesQuery.error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        <p className="font-medium">Failed to load agent capabilities. No live action occurred.</p>
        <p className="mt-1 text-xs text-destructive/80">
          Desired config was not changed, and no MCP install, connect, execute, or external action was attempted.
        </p>
      </div>
    );
  }

  const serverList = capabilitiesQuery.data?.config.mcpServers ?? [];
  const effectivePreview = showEffectivePreview
    ? resolveEffectiveConfig(capabilitiesQuery.data, effectivePreviewSettings)
    : null;

  const formatDraft = () => {
    const parsed = parseDraft(draft);
    if (!parsed.config) {
      setClientError(parsed.error ?? "Invalid JSON");
      return;
    }
    setDraft(formatConfig(parsed.config));
    setClientError(null);
  };

  const resetDraft = () => {
    if (!capabilitiesQuery.data) return;
    setDraft(formatConfig(capabilitiesQuery.data.config));
    setClientError(null);
  };

  const onAddMcpPreset = (server: AgentCapabilityMcpServer) => {
    const next = withMarketplaceMcpServer(capabilitiesQuery.data, draft, server);
    setDraft(JSON.stringify(next, null, 2));
    setClientError(null);
  };

  const onRemoveMcpPreset = (serverId: string) => {
    const next = withoutMarketplaceMcpServer(capabilitiesQuery.data, draft, serverId);
    setDraft(JSON.stringify(next, null, 2));
    setClientError(null);
  };

  const onAddCustomMcpServer = (server: AgentCapabilityMcpServer) => {
    const next = withMarketplaceMcpServer(capabilitiesQuery.data, draft, server);
    setDraft(JSON.stringify(next, null, 2));
    setClientError(null);
  };

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Desired config only — no live MCP install, connect, execute, or apply happens from this card.
            Live and external capability apply remains approval-gated.
          </p>
        </div>
        <div className="rounded-full border border-amber-300/70 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100">
          no live MCP install/execution
        </div>
      </div>

      <div role="tablist" aria-label="Capabilities workspace tabs" className="flex flex-wrap gap-1 rounded-md bg-muted p-1">
        {workspaceTabs.map((tab) => {
          const isActive = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`capability-workspace-panel-${tab.key}`}
              id={`capability-workspace-tab-${tab.key}`}
              onClick={() => setActiveTab(tab.key)}
              className={
                "min-h-[32px] rounded px-3 py-1 text-xs font-medium transition-colors " +
                (isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "summary" && (
        <div
          role="tabpanel"
          id="capability-workspace-panel-summary"
          aria-labelledby="capability-workspace-tab-summary"
          className="space-y-4"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">MCP servers</p>
              <p className="mt-1 text-2xl font-semibold">{summary.mcpServerCount}</p>
              <p className="text-[11px] text-muted-foreground">local/desired</p>
            </div>
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Skills</p>
              <p className="mt-1 text-2xl font-semibold">{summary.skillRefCount}</p>
              <p className="text-[11px] text-muted-foreground">local/desired</p>
            </div>
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Tools</p>
              <p className="mt-1 text-2xl font-semibold">{summary.toolRefCount}</p>
              <p className="text-[11px] text-muted-foreground">local/desired</p>
            </div>
          </div>

          <div className="rounded-lg border border-dashed border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Desired MCP connections</p>
                <p className="text-xs text-muted-foreground">Live state is server-owned; desired config may only request enabled/disabled.</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDraft(JSON.stringify(withPaperclipPreset(capabilitiesQuery.data, draft), null, 2))}
              >
                Add Paperclip MCP preset
              </Button>
            </div>
            {serverList.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">{emptyText}</p>
            ) : (
              <div className="mt-3 space-y-2">
                {serverList.map((server) => (
                  <div key={server.id} className="rounded-md border border-border bg-background px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{server.displayName}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{server.id}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{server.liveState}</span>
                    </div>
                    {server.requiredSecretNames.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Required named secrets: {server.requiredSecretNames.join(", ")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "marketplace" && (
        <div
          role="tabpanel"
          id="capability-workspace-panel-marketplace"
          aria-labelledby="capability-workspace-tab-marketplace"
        >
          <CapabilityMarketplacePanel
            draftConfig={parsedDraft.config}
            onAddMcpPreset={onAddMcpPreset}
            onRemoveMcpPreset={onRemoveMcpPreset}
          />
        </div>
      )}

      {activeTab === "custom" && (
        <div
          role="tabpanel"
          id="capability-workspace-panel-custom"
          aria-labelledby="capability-workspace-tab-custom"
        >
          <CustomMcpServerForm
            existingServerIds={existingDraftMcpServerIds}
            onAdd={onAddCustomMcpServer}
          />
        </div>
      )}

      {activeTab === "effective" && (
        <div
          role="tabpanel"
          id="capability-workspace-panel-effective"
          aria-labelledby="capability-workspace-tab-effective"
        >
          {effectivePreview ? (
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">Effective Preview (read-only)</p>
                  <p className="text-xs text-muted-foreground">
                    Effective capabilities resolve per category: {effectivePreview.sourceSummary}.
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Read-only preview — no live MCP install/connect/execute is triggered when this renders.
                  </p>
                </div>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">read-only</span>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div className="rounded-md border border-border bg-background/60 p-2">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">MCP servers</p>
                  <p className="mt-1 text-sm font-semibold">{effectivePreview.effective.mcpServers.length}</p>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">source: {effectivePreview.sources.mcp}</p>
                </div>
                <div className="rounded-md border border-border bg-background/60 p-2">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Skills</p>
                  <p className="mt-1 text-sm font-semibold">{effectivePreview.effective.skillRefs.length}</p>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">source: {effectivePreview.sources.skills}</p>
                </div>
                <div className="rounded-md border border-border bg-background/60 p-2">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Tools</p>
                  <p className="mt-1 text-sm font-semibold">{effectivePreview.effective.toolRefs.length}</p>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">source: {effectivePreview.sources.tools}</p>
                </div>
              </div>

              <label className="mt-3 block space-y-2">
                <span className="text-xs font-medium text-muted-foreground">Effective capability config JSON</span>
                <textarea
                  className="min-h-[180px] w-full rounded-md border border-input bg-background p-3 font-mono text-xs shadow-sm"
                  value={formatConfig(effectivePreview.effective)}
                  readOnly
                  spellCheck={false}
                  aria-label="Effective capability config JSON"
                />
              </label>
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
              Effective preview is only shown alongside global defaults.
            </p>
          )}
        </div>
      )}

      <details className="rounded-lg border border-border bg-background/60 p-3">
        <summary className="cursor-pointer text-sm font-medium">Advanced JSON fallback</summary>
        <div className="mt-3 space-y-3">
          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Schema hints</p>
            <p>
              Version 1 supports mcpServers, skillRefs, toolRefs, liveApply=false, and liveExternalActions=false. Required secrets must be named references only.
            </p>
            <p className="mt-1">
              Redaction warning: never paste raw tokens, passwords, bearer strings, private destinations, proxies, or credential material into desired config.
            </p>
          </div>
          <label className="block space-y-2">
            <span className="text-sm font-medium">Capability desired config JSON</span>
            <textarea
              className="min-h-[260px] w-full rounded-md border border-input bg-background p-3 font-mono text-xs shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setClientError(null);
              }}
              spellCheck={false}
              aria-label="Capability desired config JSON"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Advanced fallback. Marketplace selections and Save target the same desired-config payload.
          </p>

          {(parsedDraft.error || clientError || saveMutation.error) && (
            <p className="text-sm text-destructive">
              {parsedDraft.error ?? clientError ?? (saveMutation.error instanceof Error ? saveMutation.error.message : "Save failed")}. No live action occurred.
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Save writes desired config only. Approval is required before any live MCP connection, install, execution, apply, or external action.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" disabled={!draft.trim()} onClick={formatDraft}>
                Format JSON
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={!capabilitiesQuery.data} onClick={resetDraft}>
                Reset to last saved
              </Button>
              <Button
                type="button"
                disabled={saveDisabled}
                onClick={() => {
                  const parsed = parseDraft(draft);
                  if (!parsed.config) {
                    setClientError(parsed.error ?? "Invalid JSON");
                    return;
                  }
                  saveMutation.mutate(parsed.config);
                }}
              >
                {saveMutation.isPending ? "Saving…" : "Save desired config"}
              </Button>
            </div>
          </div>
        </div>
      </details>
    </section>
  );
}

export function AgentCapabilitiesCard({ agentId, companyId }: { agentId: string; companyId?: string }) {
  const companyCapabilityDefaultsQuery = useQuery({
    queryKey: queryKeys.companies.capabilities(companyId ?? ""),
    queryFn: () => companiesApi.getCapabilities(companyId ?? ""),
    enabled: Boolean(companyId),
  });

  return (
    <CapabilitySettingsCard
      title="MCP / skills / tools capabilities"
      description="Real persisted desired config for this agent. Saving here never installs, connects, or executes MCP servers; live apply stays approval-gated."
      queryKey={queryKeys.agents.capabilities(agentId)}
      queryFn={() => agentsApi.getCapabilities(agentId, companyId)}
      updateFn={(config) => agentsApi.updateCapabilities(agentId, config, companyId)}
      enabled={Boolean(agentId)}
      effectivePreviewSettings={companyCapabilityDefaultsQuery.data}
      showEffectivePreview={Boolean(companyId)}
    />
  );
}

export function CompanyCapabilityDefaultsCard({ companyId }: { companyId?: string | null }) {
  const normalizedCompanyId = companyId ?? "";
  return (
    <CapabilitySettingsCard
      title="Global MCP / skills / tools defaults"
      description="Persisted Agent OS defaults for new agents in this company. These defaults are copied into newly-created agents unless a local config is supplied."
      queryKey={queryKeys.companies.capabilities(normalizedCompanyId)}
      queryFn={() => companiesApi.getCapabilities(normalizedCompanyId)}
      updateFn={(config) => companiesApi.updateCapabilities(normalizedCompanyId, config)}
      enabled={Boolean(normalizedCompanyId)}
      emptyText="No global desired MCP defaults saved yet."
    />
  );
}
