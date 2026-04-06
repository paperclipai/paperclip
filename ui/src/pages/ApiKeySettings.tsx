import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Key,
  Plus,
  Trash2,
  Check,
  X,
  Star,
  StarOff,
  Pause,
  Play,
  AlertCircle,
  Eye,
  EyeOff,
  DollarSign,
  Users,
} from "lucide-react";
import { llmApiKeysApi, type LlmApiKey, type CreateLlmApiKeyInput } from "@/api/llmApiKeys";
import { agentsApi } from "@/api/agents";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

const PROVIDERS = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai", label: "OpenAI" },
  { value: "google", label: "Google (Gemini)" },
  { value: "other", label: "Other" },
];

function formatCurrency(value: number | null | undefined): string {
  if (value == null) return "--";
  return `$${value.toFixed(2)}`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "Never";
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ApiKeySettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [assignDialogKeyId, setAssignDialogKeyId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "API Keys" },
    ]);
  }, [setBreadcrumbs]);

  const keysQuery = useQuery({
    queryKey: queryKeys.llmApiKeys.list(selectedCompanyId ?? ""),
    queryFn: () => llmApiKeysApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateLlmApiKeyInput) =>
      llmApiKeysApi.create(selectedCompanyId!, input),
    onSuccess: () => {
      setShowAddForm(false);
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.llmApiKeys.list(selectedCompanyId!) });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to create key"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ keyId, ...patch }: { keyId: string } & Record<string, unknown>) =>
      llmApiKeysApi.update(selectedCompanyId!, keyId, patch),
    onSuccess: () => {
      setEditingKeyId(null);
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.llmApiKeys.list(selectedCompanyId!) });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to update key"),
  });

  const deleteMutation = useMutation({
    mutationFn: (keyId: string) => llmApiKeysApi.delete(selectedCompanyId!, keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.llmApiKeys.list(selectedCompanyId!) });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to delete key"),
  });

  const assignMutation = useMutation({
    mutationFn: ({ agentId, keyId }: { agentId: string; keyId: string }) =>
      llmApiKeysApi.setAgentKey(selectedCompanyId!, agentId, keyId, "manual"),
    onSuccess: () => {
      setAssignDialogKeyId(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.llmApiKeys.list(selectedCompanyId!) });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to assign key"),
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Select a company first.</div>;
  }

  if (keysQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading API keys...</div>;
  }

  const keys = keysQuery.data ?? [];
  const agents = agentsQuery.data ?? [];

  return (
    <div className="max-w-5xl space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold font-[var(--font-display)] uppercase tracking-[0.06em]">API Keys</h1>
          </div>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="inline-flex items-center gap-1.5 rounded-[2px] bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:bg-foreground/90 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Key
          </button>
        </div>
        <p className="text-sm text-muted-foreground">
          Manage LLM provider API keys. Set defaults per provider, assign specific keys to agents,
          and track usage/budget. The CEO can auto-assign the best key per task.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {actionError}
          <button onClick={() => setActionError(null)} className="ml-auto">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Add Key Form */}
      {showAddForm && (
        <AddKeyForm
          onSubmit={(input) => createMutation.mutate(input)}
          onCancel={() => setShowAddForm(false)}
          isPending={createMutation.isPending}
        />
      )}

      {/* Keys List */}
      {keys.length === 0 && !showAddForm ? (
        <div className="rounded-[2px] border border-border bg-card p-8 text-center hud-panel hud-shimmer">
          <Key className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm font-medium text-foreground mb-1">No API keys configured</p>
          <p className="text-xs text-muted-foreground mb-4">
            Add your first API key to get started. Keys are encrypted at rest.
          </p>
          <button
            onClick={() => setShowAddForm(true)}
            className="inline-flex items-center gap-1.5 rounded-[2px] bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:bg-foreground/90"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Your First Key
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {keys.map((key) => (
            <KeyCard
              key={key.id}
              apiKey={key}
              isEditing={editingKeyId === key.id}
              onStartEdit={() => setEditingKeyId(key.id)}
              onCancelEdit={() => setEditingKeyId(null)}
              onUpdate={(patch) => updateMutation.mutate({ keyId: key.id, ...patch })}
              onDelete={() => {
                if (confirm(`Delete API key "${key.name}"? This cannot be undone.`)) {
                  deleteMutation.mutate(key.id);
                }
              }}
              onToggleActive={() =>
                updateMutation.mutate({ keyId: key.id, isActive: !key.isActive })
              }
              onToggleDefault={() =>
                updateMutation.mutate({ keyId: key.id, isDefault: !key.isDefault })
              }
              onAssignToAgent={() => setAssignDialogKeyId(key.id)}
              isUpdating={updateMutation.isPending}
            />
          ))}
        </div>
      )}

      {/* Agent Assignment Dialog */}
      {assignDialogKeyId && (
        <AgentAssignDialog
          keyId={assignDialogKeyId}
          keyName={keys.find((k) => k.id === assignDialogKeyId)?.name ?? ""}
          agents={agents}
          onAssign={(agentId) => assignMutation.mutate({ agentId, keyId: assignDialogKeyId })}
          onClose={() => setAssignDialogKeyId(null)}
          isPending={assignMutation.isPending}
        />
      )}
    </div>
  );
}

// --- Add Key Form ---
function AddKeyForm({
  onSubmit,
  onCancel,
  isPending,
}: {
  onSubmit: (input: CreateLlmApiKeyInput) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [priority, setPriority] = useState(0);
  const [monthlyBudget, setMonthlyBudget] = useState("");
  const [notes, setNotes] = useState("");
  const [showKey, setShowKey] = useState(false);

  const canSubmit = name.trim() && apiKey.trim();

  return (
    <section className="rounded-[2px] border border-border bg-card p-5 space-y-4 hud-panel hud-shimmer">
      <h2 className="text-sm font-semibold font-[var(--font-display)] uppercase tracking-[0.06em]">Add New API Key</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Production Key, Team Budget Key"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-2 space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">API Key</label>
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-api03-..."
              className="w-full rounded-md border border-border bg-background px-3 py-2 pr-10 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-foreground/30"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Priority (lower = preferred)</label>
          <input
            type="number"
            min={0}
            max={100}
            value={priority}
            onChange={(e) => setPriority(parseInt(e.target.value) || 0)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Monthly Budget (USD, optional)</label>
          <input
            type="number"
            min={0}
            step={0.01}
            value={monthlyBudget}
            onChange={(e) => setMonthlyBudget(e.target.value)}
            placeholder="No limit"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
          />
        </div>

        <div className="sm:col-span-2 space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Notes (optional)</label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Internal notes about this key..."
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsDefault(!isDefault)}
            className={cn(
              "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
              isDefault ? "bg-amber-500" : "bg-muted",
            )}
          >
            <span
              className={cn(
                "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                isDefault ? "translate-x-4.5" : "translate-x-0.5",
              )}
            />
          </button>
          <span className="text-sm text-muted-foreground">Set as default for {PROVIDERS.find(p => p.value === provider)?.label ?? provider}</span>
        </div>
      </div>

      <div className="flex gap-2 pt-2">
        <button
          onClick={() => onSubmit({
            name: name.trim(),
            provider,
            apiKey: apiKey.trim(),
            isDefault,
            priority,
            monthlyBudgetUsd: monthlyBudget ? parseFloat(monthlyBudget) : null,
            notes: notes.trim() || null,
          })}
          disabled={!canSubmit || isPending}
          className="inline-flex items-center gap-1.5 rounded-[2px] bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Check className="h-3.5 w-3.5" />
          {isPending ? "Saving..." : "Save Key"}
        </button>
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 rounded-[2px] border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-[var(--sidebar-accent)]"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

// --- Key Card ---
function KeyCard({
  apiKey,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onUpdate,
  onDelete,
  onToggleActive,
  onToggleDefault,
  onAssignToAgent,
  isUpdating,
}: {
  apiKey: LlmApiKey;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
  onToggleActive: () => void;
  onToggleDefault: () => void;
  onAssignToAgent: () => void;
  isUpdating: boolean;
}) {
  const providerLabel = PROVIDERS.find((p) => p.value === apiKey.provider)?.label ?? apiKey.provider;
  const budgetPercent = apiKey.monthlyBudgetUsd
    ? Math.min(100, (apiKey.currentMonthSpendUsd / apiKey.monthlyBudgetUsd) * 100)
    : null;

  return (
    <section
      className={cn(
        "rounded-[2px] border bg-card p-4 transition-colors hud-panel hud-shimmer",
        !apiKey.isActive && "opacity-60",
        apiKey.isDefault && "border-amber-500/40",
        apiKey.lastError && "border-destructive/30",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold truncate">{apiKey.name}</h3>
            <span className="rounded-[2px] font-[var(--font-mono)] text-[9px] uppercase px-1.5 py-0.5 bg-accent text-muted-foreground">
              {providerLabel}
            </span>
            {apiKey.isDefault && (
              <span className="rounded-[2px] font-[var(--font-mono)] text-[9px] uppercase px-1.5 py-0.5 bg-[var(--status-warning)]/20 text-[var(--status-warning)]">
                Default
              </span>
            )}
            {!apiKey.isActive && (
              <span className="rounded-[2px] font-[var(--font-mono)] text-[9px] uppercase px-1.5 py-0.5 bg-muted text-muted-foreground">
                Paused
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground font-[var(--font-mono)] mt-1">{apiKey.apiKeyMasked}</p>

          {/* Stats Row */}
          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <DollarSign className="h-3 w-3" />
              Spent: {formatCurrency(apiKey.totalSpendUsd)}
            </span>
            <span>Requests: {apiKey.totalRequests.toLocaleString()}</span>
            <span>Last used: {formatDate(apiKey.lastUsedAt)}</span>
          </div>

          {/* Budget bar */}
          {apiKey.monthlyBudgetUsd != null && (
            <div className="mt-2 space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Monthly: {formatCurrency(apiKey.currentMonthSpendUsd)} / {formatCurrency(apiKey.monthlyBudgetUsd)}</span>
                <span>{budgetPercent?.toFixed(0)}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    budgetPercent! > 90 ? "bg-[var(--status-error)]" : budgetPercent! > 70 ? "bg-[var(--status-warning)]" : "bg-[var(--status-active)]",
                  )}
                  style={{ width: `${budgetPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* Error indicator */}
          {apiKey.lastError && (
            <div className="mt-2 rounded-md bg-destructive/5 border border-destructive/20 px-2 py-1.5 text-xs text-destructive">
              <span className="font-medium">Last error:</span> {apiKey.lastError}
              <span className="text-muted-foreground ml-1">({formatDate(apiKey.lastErrorAt)})</span>
            </div>
          )}

          {apiKey.notes && (
            <p className="text-xs text-muted-foreground mt-1.5 italic">{apiKey.notes}</p>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onToggleDefault}
            disabled={isUpdating}
            title={apiKey.isDefault ? "Remove default" : "Set as default"}
            className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-amber-500 transition-colors disabled:opacity-50"
          >
            {apiKey.isDefault ? <Star className="h-4 w-4 fill-amber-500 text-amber-500" /> : <StarOff className="h-4 w-4" />}
          </button>
          <button
            onClick={onToggleActive}
            disabled={isUpdating}
            title={apiKey.isActive ? "Pause key" : "Activate key"}
            className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            {apiKey.isActive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <button
            onClick={onAssignToAgent}
            title="Assign to agent"
            className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <Users className="h-4 w-4" />
          </button>
          <button
            onClick={onDelete}
            disabled={isUpdating}
            title="Delete key"
            className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </section>
  );
}

// --- Agent Assignment Dialog ---
function AgentAssignDialog({
  keyId,
  keyName,
  agents,
  onAssign,
  onClose,
  isPending,
}: {
  keyId: string;
  keyName: string;
  agents: Array<{ id: string; name: string; status: string; adapterType: string }>;
  onAssign: (agentId: string) => void;
  onClose: () => void;
  isPending: boolean;
}) {
  const [search, setSearch] = useState("");
  const filtered = agents.filter(
    (a) => a.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-[2px] shadow-xl w-full max-w-md mx-4 p-5 space-y-4 hud-panel hud-shimmer">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold font-[var(--font-display)] uppercase tracking-[0.06em]">
            Assign "{keyName}" to Agent
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agents..."
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
          autoFocus
        />

        <div className="max-h-60 overflow-y-auto space-y-1">
          {filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">No agents found</p>
          ) : (
            filtered.map((agent) => (
              <button
                key={agent.id}
                onClick={() => onAssign(agent.id)}
                disabled={isPending}
                className="w-full text-left rounded-[2px] border border-border px-3 py-2 text-sm hover:bg-[var(--sidebar-accent)] transition-colors disabled:opacity-50 flex items-center justify-between"
              >
                <div>
                  <span className="font-medium">{agent.name}</span>
                  <span className="text-xs text-muted-foreground ml-2">{agent.adapterType}</span>
                </div>
                <span
                  className={cn(
                    "text-xs px-1.5 py-0.5 rounded",
                    agent.status === "active" && "bg-[var(--status-active)]/20 text-[var(--status-active)]",
                    agent.status === "paused" && "bg-muted text-muted-foreground",
                    agent.status === "error" && "bg-[var(--status-error)]/20 text-[var(--status-error)]",
                  )}
                >
                  {agent.status}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
