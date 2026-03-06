import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companiesApi } from "../api/companies";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import type { Agent } from "@paperclipai/shared";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { ChevronDown, Pause, Play, Settings } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { Field, ToggleField, HintIcon } from "../components/agent-config-primitives";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "../lib/utils";

export function CompanySettings() {
  const { companies, selectedCompany, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
  }, [selectedCompany]);

  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? ""));

  const generalMutation = useMutation({
    mutationFn: (data: { name: string; description: string | null; brandColor: string | null }) =>
      companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
  });

  const heartbeatMutation = useMutation({
    mutationFn: ({
      companyId,
      action,
    }: {
      companyId: string;
      action: "pause" | "resume";
    }) => (action === "pause" ? companiesApi.pause(companyId) : companiesApi.resume(companyId)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      if (selectedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(selectedCompanyId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(selectedCompanyId) });
      }
    },
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(selectedCompanyId!, {
        allowedJoinTypes: "both",
        expiresInHours: 72,
      }),
    onSuccess: (invite) => {
      setInviteError(null);
      const base = window.location.origin.replace(/\/+$/, "");
      const absoluteUrl = invite.inviteUrl.startsWith("http")
        ? invite.inviteUrl
        : `${base}${invite.inviteUrl}`;
      setInviteLink(absoluteUrl);
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) });
    },
    onError: (err) => {
      setInviteError(err instanceof Error ? err.message : "Failed to create invite");
    },
  });
  const archiveMutation = useMutation({
    mutationFn: ({
      companyId,
      nextCompanyId,
    }: {
      companyId: string;
      nextCompanyId: string | null;
    }) => companiesApi.archive(companyId).then(() => ({ nextCompanyId })),
    onSuccess: async ({ nextCompanyId }) => {
      if (nextCompanyId) {
        setSelectedCompanyId(nextCompanyId);
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  function handleSaveGeneral() {
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null,
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Company Settings</h1>
      </div>

      {/* General */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          General
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field label="Company name" hint="The display name for your company.">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </Field>
          <Field label="Description" hint="Optional description shown in the company profile.">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={description}
              placeholder="Optional company description"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Appearance */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Appearance
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <CompanyPatternIcon
                companyName={companyName || selectedCompany.name}
                brandColor={brandColor || null}
                className="rounded-[14px]"
              />
            </div>
            <div className="flex-1 space-y-2">
              <Field label="Brand color" hint="Sets the hue for the company icon. Leave empty for auto-generated color.">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={brandColor || "#6366f1"}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  <input
                    type="text"
                    value={brandColor}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "" || /^#[0-9a-fA-F]{0,6}$/.test(v)) {
                        setBrandColor(v);
                      }
                    }}
                    placeholder="Auto"
                    className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                  />
                  {brandColor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrandColor("")}
                      className="text-xs text-muted-foreground"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </Field>
            </div>
          </div>
        </div>
      </div>

      {/* Save button for General + Appearance */}
      {generalDirty && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSaveGeneral}
            disabled={generalMutation.isPending || !companyName.trim()}
          >
            {generalMutation.isPending ? "Saving..." : "Save changes"}
          </Button>
          {generalMutation.isSuccess && (
            <span className="text-xs text-muted-foreground">Saved</span>
          )}
          {generalMutation.isError && (
            <span className="text-xs text-destructive">
              {generalMutation.error instanceof Error
                ? generalMutation.error.message
                : "Failed to save"}
            </span>
          )}
        </div>
      )}

      {/* Hiring */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Hiring
        </div>
        <div className="rounded-md border border-border px-4 py-3">
          <ToggleField
            label="Require board approval for new hires"
            hint="New agent hires stay pending until approved by board."
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
          />
        </div>
      </div>

      {/* Heartbeat Controls */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Heartbeat Controls
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Pause to stop all company agent heartbeats immediately. Active runs are cancelled. Resume to allow
            heartbeats again.
          </p>
          <div className="flex items-center gap-2">
            {selectedCompany.status === "paused" ? (
              <Button
                size="sm"
                onClick={() => {
                  if (!selectedCompanyId) return;
                  heartbeatMutation.mutate({ companyId: selectedCompanyId, action: "resume" });
                }}
                disabled={heartbeatMutation.isPending}
              >
                <Play className="h-3.5 w-3.5 mr-1.5" />
                {heartbeatMutation.isPending ? "Resuming..." : "Resume heartbeats"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!selectedCompanyId) return;
                  const confirmed = window.confirm(
                    `Pause all agent heartbeats for "${selectedCompany.name}"? Active runs will be cancelled.`,
                  );
                  if (!confirmed) return;
                  heartbeatMutation.mutate({ companyId: selectedCompanyId, action: "pause" });
                }}
                disabled={heartbeatMutation.isPending || selectedCompany.status === "archived"}
              >
                <Pause className="h-3.5 w-3.5 mr-1.5" />
                {heartbeatMutation.isPending ? "Pausing..." : "Pause heartbeats"}
              </Button>
            )}
            <span className="text-xs text-muted-foreground">Current status: {selectedCompany.status}</span>
          </div>
          {heartbeatMutation.isError && (
            <p className="text-xs text-destructive">
              {heartbeatMutation.error instanceof Error
                ? heartbeatMutation.error.message
                : "Failed to update heartbeat status"}
            </p>
          )}
        </div>
      </div>

      {/* Agent Models */}
      {selectedCompanyId && (
        <AgentModelsSection companyId={selectedCompanyId} />
      )}

      {/* Invites */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Invites
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Generate a link to invite humans or agents to this company.</span>
            <HintIcon text="Invite links expire after 72 hours and allow both human and agent joins." />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => inviteMutation.mutate()} disabled={inviteMutation.isPending}>
              {inviteMutation.isPending ? "Creating..." : "Create invite link"}
            </Button>
            {inviteLink && (
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await navigator.clipboard.writeText(inviteLink);
                }}
              >
                Copy link
              </Button>
            )}
          </div>
          {inviteError && <p className="text-sm text-destructive">{inviteError}</p>}
          {inviteLink && (
            <div className="rounded-md border border-border bg-muted/30 p-2">
              <div className="text-xs text-muted-foreground">Share link</div>
              <div className="mt-1 break-all font-mono text-xs">{inviteLink}</div>
            </div>
          )}
        </div>
      </div>

      {/* Archive */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-amber-700 uppercase tracking-wide">
          Archive
        </div>
        <div className="space-y-3 rounded-md border border-amber-300/60 bg-amber-100/30 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Archive this company to hide it from the sidebar. This persists in the database.
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={archiveMutation.isPending || selectedCompany.status === "archived"}
              onClick={() => {
                if (!selectedCompanyId) return;
                const confirmed = window.confirm(
                  `Archive company "${selectedCompany.name}"? It will be hidden from the sidebar.`,
                );
                if (!confirmed) return;
                const nextCompanyId = companies.find((company) =>
                  company.id !== selectedCompanyId && company.status !== "archived")?.id ?? null;
                archiveMutation.mutate({ companyId: selectedCompanyId, nextCompanyId });
              }}
            >
              {archiveMutation.isPending
                ? "Archiving..."
                : selectedCompany.status === "archived"
                  ? "Already archived"
                  : "Archive company"}
            </Button>
            {archiveMutation.isError && (
              <span className="text-xs text-destructive">
                {archiveMutation.error instanceof Error
                  ? archiveMutation.error.message
                  : "Failed to archive company"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Agent Models Section ---- */

const LOCAL_ADAPTER_TYPES = new Set(["claude_local", "codex_local"]);

const ADAPTER_OPTIONS = [
  { id: "claude_local", label: "Claude Code" },
  { id: "codex_local", label: "Codex" },
] as const;

type PendingChange = { adapter: string; model: string };

function AgentModelsSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const { data: claudeModels = [] } = useQuery({
    queryKey: ["adapter-models", "claude_local"],
    queryFn: () => agentsApi.adapterModels("claude_local"),
  });

  const { data: codexModels = [] } = useQuery({
    queryKey: ["adapter-models", "codex_local"],
    queryFn: () => agentsApi.adapterModels("codex_local"),
  });

  const localAgents = agents.filter(
    (a) => LOCAL_ADAPTER_TYPES.has(a.adapterType) && a.status !== "terminated",
  );

  // pending[agentId] = { adapter, model }
  const [pending, setPending] = useState<Record<string, PendingChange>>({});
  const isDirty = Object.keys(pending).length > 0;

  // Reset pending when agents data refreshes after save
  const agentIds = localAgents.map((a) => a.id).join(",");
  useEffect(() => { setPending({}); }, [agentIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveAll = useMutation({
    mutationFn: async () => {
      const agentMap = new Map(localAgents.map((a) => [a.id, a]));
      await Promise.all(
        Object.entries(pending).map(([agentId, change]) => {
          const agent = agentMap.get(agentId);
          if (!agent) return Promise.resolve();
          const adapterChanged = change.adapter !== agent.adapterType;
          if (adapterChanged) {
            // Full adapter switch — start with a clean adapterConfig to avoid
            // stale fields from the old adapter bleeding into the new one
            return agentsApi.update(agentId, {
              adapterType: change.adapter,
              adapterConfig: change.model ? { model: change.model } : {},
            }, companyId);
          }
          const existing = (agent.adapterConfig ?? {}) as Record<string, unknown>;
          return agentsApi.update(agentId, {
            adapterConfig: { ...existing, model: change.model || undefined },
          }, companyId);
        }),
      );
    },
    onSuccess: () => {
      setPending({});
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    },
  });

  if (localAgents.length === 0) return null;

  const modelsByAdapter: Record<string, { id: string; label: string }[]> = {
    claude_local: claudeModels,
    codex_local: codexModels,
  };

  return (
    <div className="space-y-4">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Agent Runtime
      </div>
      <div className="rounded-md border border-border divide-y divide-border">
        {localAgents.map((agent) => {
          const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
          const savedAdapter = agent.adapterType;
          const savedModel = typeof config.model === "string" ? config.model : "";

          const effectiveAdapter = pending[agent.id]?.adapter ?? savedAdapter;
          const effectiveModel = pending[agent.id]?.model ?? (
            // Reset model when adapter changed but model not yet set
            pending[agent.id]?.adapter && pending[agent.id].adapter !== savedAdapter ? "" : savedModel
          );

          const models = modelsByAdapter[effectiveAdapter] ?? [];
          const selectedModel = models.find((m) => m.id === effectiveModel);
          const isDirtyRow = agent.id in pending && (
            pending[agent.id].adapter !== savedAdapter ||
            pending[agent.id].model !== savedModel
          );

          function onChange(patch: Partial<PendingChange>) {
            setPending((prev) => {
              const current = prev[agent.id] ?? { adapter: savedAdapter, model: savedModel };
              const next = { ...current, ...patch };
              // If adapter changed, clear model so user picks intentionally
              if (patch.adapter && patch.adapter !== current.adapter) {
                next.model = "";
              }
              // Remove from pending if nothing actually changed
              if (next.adapter === savedAdapter && next.model === savedModel) {
                const { [agent.id]: _, ...rest } = prev;
                return rest;
              }
              return { ...prev, [agent.id]: next };
            });
          }

          return (
            <AgentRuntimeRow
              key={agent.id}
              agent={agent}
              effectiveAdapter={effectiveAdapter}
              effectiveModel={effectiveModel}
              modelLabel={selectedModel?.label ?? (effectiveModel || "Default")}
              models={models}
              isDirty={isDirtyRow}
              onChange={onChange}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        {isDirty && (
          <>
            <Button size="sm" onClick={() => saveAll.mutate()} disabled={saveAll.isPending}>
              {saveAll.isPending ? "Saving..." : "Save changes"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPending({})}
              disabled={saveAll.isPending}
              className="text-muted-foreground"
            >
              Cancel
            </Button>
          </>
        )}
        {saveAll.isSuccess && !isDirty && (
          <span className="text-xs text-muted-foreground">Saved</span>
        )}
        {saveAll.isError && (
          <span className="text-xs text-destructive">
            {saveAll.error instanceof Error ? saveAll.error.message : "Failed to save"}
          </span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground/60">
        Changes apply on the next heartbeat run. Switching adapter resets all adapter-specific config.
      </p>
    </div>
  );
}

function AgentRuntimeRow({
  agent,
  effectiveAdapter,
  effectiveModel,
  modelLabel,
  models,
  isDirty,
  onChange,
}: {
  agent: Agent;
  effectiveAdapter: string;
  effectiveModel: string;
  modelLabel: string;
  models: { id: string; label: string }[];
  isDirty: boolean;
  onChange: (patch: Partial<PendingChange>) => void;
}) {
  const [adapterOpen, setAdapterOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filteredModels = models.filter((m) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q);
  });

  const adapterLabel = ADAPTER_OPTIONS.find((a) => a.id === effectiveAdapter)?.label ?? effectiveAdapter;

  return (
    <div className={cn("flex items-center gap-2 px-4 py-2.5", isDirty && "bg-accent/20")}>
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">{agent.name}</div>
      </div>
      {isDirty && (
        <span className="text-[10px] text-amber-600 dark:text-amber-400 shrink-0">unsaved</span>
      )}

      {/* Adapter dropdown */}
      <div className="w-32 shrink-0">
        <Popover open={adapterOpen} onOpenChange={setAdapterOpen}>
          <PopoverTrigger asChild>
            <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
              <span>{adapterLabel}</span>
              <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-36 p-1" align="start">
            {ADAPTER_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                className={cn(
                  "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                  opt.id === effectiveAdapter && "bg-accent",
                )}
                onClick={() => { onChange({ adapter: opt.id }); setAdapterOpen(false); }}
              >
                {opt.label}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </div>

      {/* Model dropdown */}
      <div className="w-44 shrink-0">
        <Popover open={modelOpen} onOpenChange={(o) => { setModelOpen(o); if (!o) setSearch(""); }}>
          <PopoverTrigger asChild>
            <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
              <span className={cn(!effectiveModel && "text-muted-foreground text-xs")}>
                {modelLabel}
              </span>
              <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-1" align="end">
            <input
              className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
              placeholder="Search models..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            <div className="max-h-[200px] overflow-y-auto">
              <button
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                  !effectiveModel && "bg-accent",
                )}
                onClick={() => { onChange({ model: "" }); setModelOpen(false); }}
              >
                <span className="text-muted-foreground">Default</span>
              </button>
              {filteredModels.map((m) => (
                <button
                  key={m.id}
                  className={cn(
                    "flex items-center justify-between w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                    m.id === effectiveModel && "bg-accent",
                  )}
                  onClick={() => { onChange({ model: m.id }); setModelOpen(false); }}
                >
                  <span>{m.label}</span>
                  <span className="text-[10px] text-muted-foreground font-mono ml-2 shrink-0">{m.id}</span>
                </button>
              ))}
              {filteredModels.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No models found.</p>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
