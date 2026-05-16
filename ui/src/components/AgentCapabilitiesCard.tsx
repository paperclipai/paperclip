import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgentCapabilityConfig,
  AgentCapabilityConfigInput,
  AgentCapabilitySettingsResponse,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";

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

function uniqueRequiredSecretNames(config: AgentCapabilityConfig | undefined) {
  return Array.from(new Set(config?.mcpServers.flatMap((server) => server.requiredSecretNames) ?? [])).sort();
}

function summarize(settings: AgentCapabilitySettingsResponse | undefined) {
  const config = settings?.config;
  const mcpServerCount = config?.mcpServers.length ?? 0;
  const skillRefCount = config?.skillRefs.length ?? 0;
  const toolRefCount = config?.toolRefs.length ?? 0;
  const knowledgeRefCount = 0;
  const desiredTotal = mcpServerCount + skillRefCount + toolRefCount + knowledgeRefCount;
  const requiredSecretCount = uniqueRequiredSecretNames(config).length;
  const approvalRequiredCount = settings?.applyPreview.requiresApprovalForLiveApply && desiredTotal > 0 ? desiredTotal : 0;

  return {
    mcpServerCount,
    skillRefCount,
    toolRefCount,
    knowledgeRefCount,
    desiredTotal,
    requiredSecretCount,
    approvalRequiredCount,
    errorCount: 0,
  };
}

function sourceScopeLabel(settings: AgentCapabilitySettingsResponse | undefined, fallback: "agent" | "company") {
  if (settings?.scope === "company_default") return "Company global";
  if (settings?.scope === "agent_local") return "Agent local";
  return fallback === "company" ? "Company global" : "Agent local";
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

function PostureChip({ children, tone = "neutral" }: { children: string; tone?: "neutral" | "safe" | "warning" }) {
  const toneClass =
    tone === "safe"
      ? "border-emerald-300/70 bg-emerald-50 text-emerald-900 dark:border-emerald-400/40 dark:bg-emerald-950/30 dark:text-emerald-100"
      : tone === "warning"
        ? "border-amber-300/70 bg-amber-50 text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100"
        : "border-border bg-muted/50 text-muted-foreground";

  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide ${toneClass}`}>
      {children}
    </span>
  );
}

function CapabilityPostureChips() {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Capability safety posture">
      <PostureChip tone="safe">BACKEND-BACKED</PostureChip>
      <PostureChip tone="safe">DESIRED CONFIG ONLY</PostureChip>
      <PostureChip tone="warning">APPROVAL REQUIRED</PostureChip>
      <PostureChip tone="warning">LIVE APPLY DISABLED</PostureChip>
    </div>
  );
}

function SummaryTile({ label, value, helper }: { label: string; value: string | number; helper?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/60 p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {helper ? <p className="mt-1 text-xs text-muted-foreground">{helper}</p> : null}
    </div>
  );
}

function CapabilityWorkspaceHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Capability workspace</p>
        <h2 className="mt-1 text-lg font-semibold">{title}</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
      <CapabilityPostureChips />
    </div>
  );
}

function CapabilitySettingsCard({
  title,
  description,
  queryKey,
  queryFn,
  updateFn,
  enabled = true,
  emptyText = "No desired capabilities saved yet.",
  scopeFallback = "agent",
}: {
  title: string;
  description: string;
  queryKey: readonly unknown[];
  queryFn: () => Promise<AgentCapabilitySettingsResponse>;
  updateFn: (config: AgentCapabilityConfigInput) => Promise<AgentCapabilitySettingsResponse>;
  enabled?: boolean;
  emptyText?: string;
  scopeFallback?: "agent" | "company";
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);

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

  if (capabilitiesQuery.isLoading) {
    return (
      <section className="space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm" aria-busy="true">
        <CapabilityWorkspaceHeader title={title} description={description} />
        <div className="grid gap-3 sm:grid-cols-4">
          <SummaryTile label="MCP servers" value="—" helper="desired count loading" />
          <SummaryTile label="Skills" value="—" helper="desired count loading" />
          <SummaryTile label="Tools" value="—" helper="desired count loading" />
          <SummaryTile label="Knowledge refs" value="—" helper="not modeled in this slice" />
        </div>
        <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Loading capability workspace…</p>
          <p>No live action occurred.</p>
        </div>
      </section>
    );
  }

  if (capabilitiesQuery.error) {
    return (
      <section className="space-y-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4 shadow-sm">
        <CapabilityWorkspaceHeader title={title} description={description} />
        <div className="rounded-lg border border-destructive/40 bg-background/80 p-3 text-sm text-destructive">
          <p className="font-medium">Failed to load capabilities. No live action occurred.</p>
          <p className="mt-1 text-xs text-destructive/80">
            Desired config was not changed, and no MCP install, connect, execute, or external action was attempted.
          </p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void capabilitiesQuery.refetch()}>
            Retry loading desired config
          </Button>
        </div>
      </section>
    );
  }

  const settings = capabilitiesQuery.data;
  const serverList = settings?.config.mcpServers ?? [];
  const sourceScope = sourceScopeLabel(settings, scopeFallback);
  const requiredSecretNames = uniqueRequiredSecretNames(settings?.config);

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
    if (!settings) return;
    setDraft(formatConfig(settings.config));
    setClientError(null);
  };

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm">
      <CapabilityWorkspaceHeader title={title} description={description} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryTile label="Source scope" value={sourceScope} helper="server persisted" />
        <SummaryTile label="MCP servers" value={summary.mcpServerCount} helper="desired" />
        <SummaryTile label="Skills" value={summary.skillRefCount} helper="desired" />
        <SummaryTile label="Tools" value={summary.toolRefCount} helper="desired" />
        <SummaryTile label="Knowledge refs" value={summary.knowledgeRefCount} helper="future slice" />
      </div>

      <div className="rounded-lg border border-border bg-background/60 p-3 text-sm">
        <p className="font-medium">Desired-vs-live posture</p>
        <p className="mt-1 text-muted-foreground">
          0 applied / {summary.desiredTotal} desired / {summary.requiredSecretCount} require secret / {summary.approvalRequiredCount} require approval / {summary.errorCount} errors.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Live state is server-owned. This workspace edits desired config only; approval is required before any future live MCP install, connect, execute, apply, or external action.
        </p>
        {requiredSecretNames.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Required named secrets: {requiredSecretNames.join(", ")}. Secret values are never displayed or accepted here.
          </p>
        ) : null}
      </div>

      <div className="rounded-lg border border-dashed border-border p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-medium">Desired MCP connections</p>
            <p className="text-xs text-muted-foreground">
              Desired state is persisted configuration. Live posture remains server-owned and cannot be claimed by this client.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDraft(JSON.stringify(withPaperclipPreset(settings, draft), null, 2))}
          >
            Add Paperclip MCP preset
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Paperclip MCP preset is saved as desired config only; it does not install, connect, or execute.
        </p>
        {serverList.length === 0 ? (
          <div className="mt-3 rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
            <p>{emptyText}</p>
            <p className="mt-1 text-xs">
              Marketplace selection is a later LET-140 slice. Use the preset button or the Advanced JSON fallback for this safe shell slice.
            </p>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {serverList.map((server) => (
              <div key={server.id} className="rounded-md border border-border bg-background px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{server.displayName}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{server.id}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    Desired state: {server.desiredState}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    Live posture: {server.liveState} (server-owned)
                  </span>
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
              <Button type="button" variant="outline" size="sm" disabled={!settings} onClick={resetDraft}>
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
  return (
    <CapabilitySettingsCard
      title="MCP / skills / tools capabilities"
      description="Real persisted desired config for this agent. Saving here never installs, connects, or executes MCP servers; live apply stays approval-gated."
      queryKey={queryKeys.agents.capabilities(agentId)}
      queryFn={() => agentsApi.getCapabilities(agentId, companyId)}
      updateFn={(config) => agentsApi.updateCapabilities(agentId, config, companyId)}
      enabled={Boolean(agentId)}
      scopeFallback="agent"
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
      scopeFallback="company"
    />
  );
}
