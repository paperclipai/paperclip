import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GatewayRouteWithHealth, EnvBinding } from "@paperclipai/shared";
import {
  Activity,
  AlertTriangle,
  ArrowUpDown,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleOff,
  Network,
  Pencil,
  Plus,
  RotateCcw,
  Shield,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { gatewayApi } from "../api/gateway";
import { agentsApi } from "../api/agents";
import { secretsApi } from "../api/secrets";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { AdapterTypeDropdown } from "../components/AgentConfigForm";
import { EnvVarEditor } from "../components/EnvVarEditor";
import { Field, DraftInput, DraftNumberInput, help } from "../components/agent-config-primitives";
import { TagInput } from "../components/TagInput";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function CircuitBadge({ state }: { state: string }) {
  const map: Record<string, { label: string; cls: string; icon: typeof CheckCircle2 }> = {
    closed: { label: "Healthy", cls: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20", icon: CheckCircle2 },
    half_open: { label: "Probing", cls: "text-amber-400 bg-amber-400/10 border-amber-400/20", icon: AlertTriangle },
    open: { label: "Open", cls: "text-red-400 bg-red-400/10 border-red-400/20", icon: XCircle },
  };
  const info = map[state] ?? map.closed;
  const Icon = info.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px] font-medium", info.cls)}>
      <Icon className="h-3 w-3" />
      {info.label}
    </span>
  );
}

function UsageBar({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number | null;
}) {
  if (limit == null) return null;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {used.toLocaleString()} / {limit.toLocaleString()} ({pct}%)
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden bg-muted">
        <div
          className={cn(
            "h-full transition-all duration-200",
            pct > 90 ? "bg-red-400" : pct > 60 ? "bg-amber-400" : "bg-emerald-400",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared form state type & hook
// ---------------------------------------------------------------------------

interface RouteFormState {
  name: string;
  adapterType: string;
  model: string;
  priority: number;
  weight: number;
  timeoutSec: string;
  cbEnabled: boolean;
  cbThreshold: number;
  cbResetSec: number;
  tokPerMin: string;
  tokPerHour: string;
  tokPerDay: string;
  reqPerMin: string;
  reqPerHour: string;
  reqPerDay: string;
  maxTurns: string;
  extraArgs: string;
  thinkingEffort: string;
  envBindings: Record<string, EnvBinding> | undefined;
  showAdapterConfig: boolean;
  fallbackModels: string[];
}

function emptyFormState(): RouteFormState {
  return {
    name: "",
    adapterType: "opencode_local",
    model: "",
    priority: 0,
    weight: 100,
    timeoutSec: "",
    cbEnabled: false,
    cbThreshold: 3,
    cbResetSec: 300,
    tokPerMin: "",
    tokPerHour: "",
    tokPerDay: "",
    reqPerMin: "",
    reqPerHour: "",
    reqPerDay: "",
    maxTurns: "",
    extraArgs: "",
    thinkingEffort: "",
    envBindings: undefined,
    showAdapterConfig: false,
    fallbackModels: [],
  };
}

function routeToFormState(r: GatewayRouteWithHealth): RouteFormState {
  const overrides = (r.adapterConfigOverrides ?? {}) as Record<string, unknown>;
  const fbModels = Array.isArray(overrides.fallbackModels)
    ? (overrides.fallbackModels as string[])
    : [];
  return {
    name: r.name,
    adapterType: r.adapterType,
    model: r.model,
    priority: r.priority,
    weight: r.weight,
    timeoutSec: r.timeoutSec != null ? String(r.timeoutSec) : "",
    cbEnabled: r.circuitBreakerEnabled,
    cbThreshold: r.circuitBreakerFailureThreshold,
    cbResetSec: r.circuitBreakerResetSec,
    tokPerMin: r.quotaTokensPerMinute != null ? String(r.quotaTokensPerMinute) : "",
    tokPerHour: r.quotaTokensPerHour != null ? String(r.quotaTokensPerHour) : "",
    tokPerDay: r.quotaTokensPerDay != null ? String(r.quotaTokensPerDay) : "",
    reqPerMin: r.quotaRequestsPerMinute != null ? String(r.quotaRequestsPerMinute) : "",
    reqPerHour: r.quotaRequestsPerHour != null ? String(r.quotaRequestsPerHour) : "",
    reqPerDay: r.quotaRequestsPerDay != null ? String(r.quotaRequestsPerDay) : "",
    maxTurns: overrides.maxTurns != null ? String(overrides.maxTurns) : "",
    extraArgs: Array.isArray(overrides.extraArgs) ? (overrides.extraArgs as string[]).join(", ") : "",
    thinkingEffort: typeof overrides.thinkingBudgetTokens === "string" ? overrides.thinkingBudgetTokens : "",
    envBindings: (typeof overrides.env === "object" && overrides.env !== null)
      ? overrides.env as Record<string, EnvBinding>
      : undefined,
    showAdapterConfig: false,
    fallbackModels: fbModels,
  };
}

function buildAdapterConfigOverrides(s: RouteFormState): Record<string, unknown> | null {
  const overrides: Record<string, unknown> = {};
  if (s.maxTurns) overrides.maxTurns = Number(s.maxTurns);
  if (s.extraArgs) overrides.extraArgs = s.extraArgs.split(",").map((v: string) => v.trim()).filter(Boolean);
  if (s.thinkingEffort) overrides.thinkingBudgetTokens = s.thinkingEffort;
  if (s.envBindings && Object.keys(s.envBindings).length > 0) overrides.env = s.envBindings;
  if (s.fallbackModels.length > 0) overrides.fallbackModels = s.fallbackModels;
  return Object.keys(overrides).length > 0 ? overrides : null;
}

function formStateToPayload(s: RouteFormState, agentId?: string) {
  return {
    agentId: agentId || null,
    name: s.name || `${s.adapterType}/${s.model}`,
    adapterType: s.adapterType,
    model: s.model,
    priority: s.priority,
    weight: s.weight,
    timeoutSec: s.timeoutSec ? Number(s.timeoutSec) : null,
    circuitBreakerEnabled: s.cbEnabled,
    circuitBreakerFailureThreshold: s.cbThreshold,
    circuitBreakerResetSec: s.cbResetSec,
    quotaTokensPerMinute: s.tokPerMin ? Number(s.tokPerMin) : null,
    quotaTokensPerHour: s.tokPerHour ? Number(s.tokPerHour) : null,
    quotaTokensPerDay: s.tokPerDay ? Number(s.tokPerDay) : null,
    quotaRequestsPerMinute: s.reqPerMin ? Number(s.reqPerMin) : null,
    quotaRequestsPerHour: s.reqPerHour ? Number(s.reqPerHour) : null,
    quotaRequestsPerDay: s.reqPerDay ? Number(s.reqPerDay) : null,
    adapterConfigOverrides: buildAdapterConfigOverrides(s),
  };
}

// ---------------------------------------------------------------------------
// Shared route form fields
// ---------------------------------------------------------------------------

function RouteFormFields({
  s,
  set,
  companyId,
  disabledTypes,
  modelSuggestions,
}: {
  s: RouteFormState;
  set: (patch: Partial<RouteFormState>) => void;
  companyId: string;
  disabledTypes: Set<string>;
  modelSuggestions: string[];
}) {
  // Fetch adapter models for the selected adapter type
  const { data: adapterModels } = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, s.adapterType),
    queryFn: () => agentsApi.adapterModels(companyId, s.adapterType),
    enabled: Boolean(companyId),
  });

  // Fetch company secrets for EnvVarEditor
  const queryClient = useQueryClient();
  const { data: availableSecrets = [] } = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
    enabled: Boolean(companyId),
  });

  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) =>
      secretsApi.create(companyId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
    },
  });

  // Model placeholder based on adapter type
  const modelPlaceholder = useMemo(() => {
    if (adapterModels?.length) {
      return `e.g. ${adapterModels[0].id}`;
    }
    const defaults: Record<string, string> = {
      opencode_local: "e.g. opencode/qwen3.6-plus-free",
      gemini_local: "e.g. auto",
      claude_local: "e.g. sonnet",
      codex_local: "e.g. o4-mini",
      cursor: "e.g. auto",
    };
    return defaults[s.adapterType] ?? "Model identifier";
  }, [s.adapterType, adapterModels]);

  // Suggestions for fallback models: adapter models + passed-in history
  const fallbackSuggestions = useMemo(() => {
    const ids = new Set<string>();
    for (const m of adapterModels ?? []) ids.add(m.id);
    for (const m of modelSuggestions) ids.add(m);
    // Remove current primary model from suggestions
    ids.delete(s.model);
    return Array.from(ids);
  }, [adapterModels, modelSuggestions, s.model]);

  const inputCls = "w-full bg-transparent border border-border px-2 py-1.5 text-sm outline-none focus:border-foreground/40 transition-colors";
  const labelCls = "text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1";

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <div className={labelCls}>Name</div>
          <input className={inputCls} value={s.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Primary GPT" />
        </div>
        <Field label="Adapter Type" hint={help.adapterType}>
          <AdapterTypeDropdown
            value={s.adapterType}
            onChange={(t) => { set({ adapterType: t, model: "" }); }}
            disabledTypes={disabledTypes}
          />
        </Field>
        <Field label="Model" hint={help.model}>
          <DraftInput
            value={s.model}
            onCommit={(v) => set({ model: v })}
            immediate
            className={inputCls}
            placeholder={modelPlaceholder}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className={labelCls}>Priority</div>
            <input type="number" className={inputCls} value={s.priority} onChange={(e) => set({ priority: Number(e.target.value) })} />
          </div>
          <div>
            <div className={labelCls}>Weight</div>
            <input type="number" className={inputCls} value={s.weight} onChange={(e) => set({ weight: Number(e.target.value) })} />
          </div>
        </div>
      </div>

      {/* Fallback Models */}
      <Field label="Fallback models" hint="Ordered list of fallback model IDs. Press Enter or comma to add. Drag to reorder.">
        <TagInput
          value={s.fallbackModels}
          onChange={(tags) => set({ fallbackModels: tags })}
          suggestions={fallbackSuggestions}
          placeholder={
            s.adapterType === "gemini_local"
              ? "e.g. gemini-2.5-flash"
              : s.adapterType === "opencode_local"
                ? "e.g. opencode/qwen3.6-plus-free"
                : "e.g. model-id"
          }
        />
      </Field>

      {/* Quota configuration */}
      <div>
        <div className={labelCls}>Token Quotas</div>
        <div className="grid grid-cols-3 gap-2">
          <input className={inputCls} value={s.tokPerMin} onChange={(e) => set({ tokPerMin: e.target.value })} placeholder="/min" />
          <input className={inputCls} value={s.tokPerHour} onChange={(e) => set({ tokPerHour: e.target.value })} placeholder="/hour" />
          <input className={inputCls} value={s.tokPerDay} onChange={(e) => set({ tokPerDay: e.target.value })} placeholder="/day" />
        </div>
      </div>
      <div>
        <div className={labelCls}>Request Quotas</div>
        <div className="grid grid-cols-3 gap-2">
          <input className={inputCls} value={s.reqPerMin} onChange={(e) => set({ reqPerMin: e.target.value })} placeholder="/min" />
          <input className={inputCls} value={s.reqPerHour} onChange={(e) => set({ reqPerHour: e.target.value })} placeholder="/hour" />
          <input className={inputCls} value={s.reqPerDay} onChange={(e) => set({ reqPerDay: e.target.value })} placeholder="/day" />
        </div>
      </div>

      {/* Timeout & circuit breaker */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Timeout (sec)" hint={help.timeoutSec}>
          <DraftInput
            value={s.timeoutSec}
            onCommit={(v) => set({ timeoutSec: v })}
            immediate
            className={inputCls}
            placeholder="Use agent default"
          />
        </Field>
        <div>
          <div className={labelCls}>Circuit Breaker</div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="checkbox" checked={s.cbEnabled} onChange={(e) => set({ cbEnabled: e.target.checked })} />
              Enabled
            </label>
            {s.cbEnabled && (
              <>
                <input type="number" className={cn(inputCls, "w-16")} value={s.cbThreshold} onChange={(e) => set({ cbThreshold: Number(e.target.value) })} title="Failure threshold" />
                <input type="number" className={cn(inputCls, "w-20")} value={s.cbResetSec} onChange={(e) => set({ cbResetSec: Number(e.target.value) })} title="Reset seconds" />
              </>
            )}
          </div>
        </div>
      </div>

      {/* Adapter config overrides (collapsible) */}
      <div>
        <button
          type="button"
          onClick={() => set({ showAdapterConfig: !s.showAdapterConfig })}
          className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        >
          {s.showAdapterConfig ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Adapter Config Overrides
        </button>
        {s.showAdapterConfig && (
          <div className="mt-2 space-y-3 border-l-2 border-border pl-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Max turns per run" hint={help.maxTurnsPerRun}>
                <DraftNumberInput
                  value={s.maxTurns ? Number(s.maxTurns) : 0}
                  onCommit={(v) => set({ maxTurns: v ? String(v) : "" })}
                  immediate
                  className={inputCls}
                  placeholder="e.g. 1000"
                />
              </Field>
              <Field label="Thinking effort" hint={help.thinkingEffort}>
                <DraftInput
                  value={s.thinkingEffort}
                  onCommit={(v) => set({ thinkingEffort: v })}
                  immediate
                  className={inputCls}
                  placeholder="e.g. high"
                />
              </Field>
              <Field label="Extra args (comma-separated)" hint={help.extraArgs}>
                <DraftInput
                  value={s.extraArgs}
                  onCommit={(v) => set({ extraArgs: v })}
                  immediate
                  className={inputCls}
                  placeholder="--verbose, --foo=bar"
                />
              </Field>
            </div>
            <Field label="Environment variables" hint={help.envVars}>
              <EnvVarEditor
                value={s.envBindings ?? {}}
                secrets={availableSecrets}
                onCreateSecret={async (name, value) => {
                  const created = await createSecret.mutateAsync({ name, value });
                  return created;
                }}
                onChange={(env) => set({ envBindings: env })}
              />
            </Field>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Route card
// ---------------------------------------------------------------------------

function RouteCard({
  route,
  companyId,
  agentId,
  onToggle,
  onDelete,
  onResetCircuit,
  isExpanded,
  onToggleExpand,
}: {
  route: GatewayRouteWithHealth;
  companyId: string;
  agentId?: string;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onResetCircuit: () => void;
  isExpanded: boolean;
  onToggleExpand: () => void;
}) {
  const h = route.health;
  const queryClient = useQueryClient();
  const disabledTypes = useDisabledAdaptersSync();
  const [editing, setEditing] = useState(false);
  const [editState, setEditState] = useState<RouteFormState>(() => routeToFormState(route));

  const updateSet = (patch: Partial<RouteFormState>) =>
    setEditState((prev) => ({ ...prev, ...patch }));

  const updateMut = useMutation({
    mutationFn: () =>
      gatewayApi.updateRoute(companyId, route.id, formStateToPayload(editState, agentId)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.gateway.routes(companyId, agentId) });
      setEditing(false);
    },
  });

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditState(routeToFormState(route));
    setEditing(true);
  };

  const handleCancelEdit = () => {
    setEditState(routeToFormState(route));
    setEditing(false);
  };

  // Fallback models from adapter config overrides (read-only display)
  const overrides = (route.adapterConfigOverrides ?? {}) as Record<string, unknown>;
  const fallbackModels = Array.isArray(overrides.fallbackModels)
    ? (overrides.fallbackModels as string[])
    : [];

  return (
    <div className={cn("border border-border transition-colors", !route.isEnabled && "opacity-50")}>
      {/* Header */}
      <div
        className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-2 min-w-0">
          {isExpanded
            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{route.name}</span>
              <CircuitBadge state={h.circuitState} />
              <span className="text-[11px] text-muted-foreground font-mono">P{route.priority}</span>
              <span className="text-[11px] text-muted-foreground">W{route.weight}</span>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5 font-mono truncate">
              {route.adapterType} → {route.model}
              {fallbackModels.length > 0 && (
                <span className="text-muted-foreground/60"> · {fallbackModels.length} fallback{fallbackModels.length !== 1 ? "s" : ""}</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Quick usage summary */}
          <div className="text-right text-[11px] text-muted-foreground tabular-nums hidden sm:block">
            <div>{h.usage.day.requests} req/day</div>
            <div>{h.usage.day.tokens.toLocaleString()} tok/day</div>
          </div>
          {/* Enable toggle */}
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(!route.isEnabled); }}
            className={cn(
              "relative h-5 w-9 shrink-0 border transition-colors",
              route.isEnabled
                ? "bg-emerald-500/20 border-emerald-500/40"
                : "bg-muted border-border",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-3.5 w-3.5 border transition-transform",
                route.isEnabled
                  ? "translate-x-4 bg-emerald-400 border-emerald-500"
                  : "translate-x-0.5 bg-muted-foreground/40 border-border",
              )}
            />
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          {editing ? (
            /* ---- EDIT MODE ---- */
            <div className="space-y-4">
              <RouteFormFields
                s={editState}
                set={updateSet}
                companyId={companyId}
                disabledTypes={disabledTypes}
                modelSuggestions={[]}
              />
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" onClick={() => updateMut.mutate()} disabled={!editState.model || updateMut.isPending}>
                  {updateMut.isPending ? "Saving…" : "Save Changes"}
                </Button>
                <Button variant="ghost" size="sm" onClick={handleCancelEdit}>Cancel</Button>
                {updateMut.error && (
                  <span className="text-xs text-red-400">{(updateMut.error as Error).message}</span>
                )}
              </div>
            </div>
          ) : (
            /* ---- READ MODE ---- */
            <>
              {/* Rate limit bars */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Per Minute</div>
                  <UsageBar label="Tokens" used={h.usage.minute.tokens} limit={route.quotaTokensPerMinute} />
                  <UsageBar label="Requests" used={h.usage.minute.requests} limit={route.quotaRequestsPerMinute} />
                  {!route.quotaTokensPerMinute && !route.quotaRequestsPerMinute && (
                    <div className="text-[10px] text-muted-foreground/50">No limit</div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Per Hour</div>
                  <UsageBar label="Tokens" used={h.usage.hour.tokens} limit={route.quotaTokensPerHour} />
                  <UsageBar label="Requests" used={h.usage.hour.requests} limit={route.quotaRequestsPerHour} />
                  {!route.quotaTokensPerHour && !route.quotaRequestsPerHour && (
                    <div className="text-[10px] text-muted-foreground/50">No limit</div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Per Day</div>
                  <UsageBar label="Tokens" used={h.usage.day.tokens} limit={route.quotaTokensPerDay} />
                  <UsageBar label="Requests" used={h.usage.day.requests} limit={route.quotaRequestsPerDay} />
                  {!route.quotaTokensPerDay && !route.quotaRequestsPerDay && (
                    <div className="text-[10px] text-muted-foreground/50">No limit</div>
                  )}
                </div>
              </div>

              {/* Fallback models read-only */}
              {fallbackModels.length > 0 && (
                <div className="border border-border px-3 py-2">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Fallback Models</div>
                  <div className="flex flex-wrap gap-1.5">
                    {fallbackModels.map((m, i) => (
                      <span key={`${m}-${i}`} className="inline-flex items-center gap-1 border border-border bg-accent/40 px-1.5 py-0.5 text-[11px] font-mono text-foreground">
                        <span className="text-muted-foreground/60 text-[9px]">{i + 1}</span>
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Circuit breaker detail */}
              {route.circuitBreakerEnabled && (
                <div className="flex items-center gap-3 border border-border px-3 py-2">
                  <Shield className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <div className="text-xs text-muted-foreground">
                    Circuit breaker: <span className="text-foreground font-medium">{h.circuitState}</span>
                    {" · "}Failures: {h.failureCount}/{route.circuitBreakerFailureThreshold}
                    {" · "}Reset: {route.circuitBreakerResetSec}s
                    {h.lastFailureAt && (
                      <span> · Last failure: {new Date(h.lastFailureAt).toLocaleString()}</span>
                    )}
                  </div>
                  {h.circuitState !== "closed" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-6 px-2 text-xs"
                      onClick={onResetCircuit}
                    >
                      <RotateCcw className="h-3 w-3 mr-1" />
                      Reset
                    </Button>
                  )}
                </div>
              )}

              {/* Adapter config overrides (excluding fallbackModels which is shown above) */}
              {(() => {
                const displayOverrides = { ...overrides };
                delete displayOverrides.fallbackModels;
                return Object.keys(displayOverrides).length > 0 ? (
                  <div className="border border-border px-3 py-2">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Adapter Config Overrides</div>
                    <pre className="text-[11px] text-muted-foreground font-mono whitespace-pre-wrap break-all">
                      {JSON.stringify(displayOverrides, null, 2)}
                    </pre>
                  </div>
                ) : null;
              })()}

              {/* Meta row */}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {route.timeoutSec != null && (
                  <span>Timeout: {route.timeoutSec}s</span>
                )}
                <span>
                  Scope: {route.agentId ? "Agent-specific" : "Company-wide"}
                </span>
                <span className="ml-auto opacity-60 text-[10px]">
                  {route.id.slice(0, 8)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={handleStartEdit}
                >
                  <Pencil className="h-3 w-3 mr-1" />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-red-400 hover:text-red-300 hover:bg-red-400/10"
                  onClick={(e) => { e.stopPropagation(); onDelete(); }}
                >
                  <Trash2 className="h-3 w-3 mr-1" />
                  Delete
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create route form
// ---------------------------------------------------------------------------

function CreateRouteForm({
  companyId,
  agentId,
  onCreated,
  onCancel,
}: {
  companyId: string;
  agentId?: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const disabledTypes = useDisabledAdaptersSync();
  const [s, setS] = useState<RouteFormState>(emptyFormState);

  const set = (patch: Partial<RouteFormState>) =>
    setS((prev) => ({ ...prev, ...patch }));

  const mutation = useMutation({
    mutationFn: () =>
      gatewayApi.createRoute(companyId, formStateToPayload(s, agentId)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.gateway.routes(companyId, agentId) });
      onCreated();
    },
  });

  return (
    <div className="border border-border p-4 space-y-4">
      <div className="text-sm font-medium flex items-center gap-2">
        <Plus className="h-4 w-4" />
        Add Route
      </div>

      <RouteFormFields
        s={s}
        set={set}
        companyId={companyId}
        disabledTypes={disabledTypes}
        modelSuggestions={[]}
      />

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" onClick={() => mutation.mutate()} disabled={!s.model || mutation.isPending}>
          {mutation.isPending ? "Creating…" : "Create Route"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        {mutation.error && (
          <span className="text-xs text-red-400">{(mutation.error as Error).message}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function GatewayRouting({ agentId }: { agentId?: string }) {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [expandedRoutes, setExpandedRoutes] = useState<Set<string>>(new Set());

  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    if (!agentId) {
      setBreadcrumbs([{ label: "Gateway Routing" }]);
    }
  }, [setBreadcrumbs, agentId]);

  const { data: routes, isLoading } = useQuery({
    queryKey: queryKeys.gateway.routes(companyId, agentId),
    queryFn: () => gatewayApi.listRoutes(companyId, agentId),
    enabled: !!companyId,
    refetchInterval: 10_000,
    staleTime: 3_000,
  });

  const toggleMut = useMutation({
    mutationFn: ({ routeId, isEnabled }: { routeId: string; isEnabled: boolean }) =>
      gatewayApi.updateRoute(companyId, routeId, { isEnabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.gateway.routes(companyId, agentId) }),
  });

  const deleteMut = useMutation({
    mutationFn: (routeId: string) => gatewayApi.deleteRoute(companyId, routeId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.gateway.routes(companyId, agentId) }),
  });

  const resetCircuitMut = useMutation({
    mutationFn: (routeId: string) => gatewayApi.resetCircuit(companyId, routeId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.gateway.routes(companyId, agentId) }),
  });

  // Group routes by priority
  const groupedRoutes = useMemo(() => {
    if (!routes) return [];
    const map = new Map<number, GatewayRouteWithHealth[]>();
    for (const route of routes) {
      const group = map.get(route.priority) ?? [];
      group.push(route);
      map.set(route.priority, group);
    }
    return Array.from(map.entries()).sort(([a], [b]) => b - a);
  }, [routes]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select a company to configure gateway routing." />;
  }

  const toggleExpand = (id: string) =>
    setExpandedRoutes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  // Stats summary
  const totalRoutes = routes?.length ?? 0;
  const enabledRoutes = routes?.filter((r) => r.isEnabled).length ?? 0;
  const openCircuits = routes?.filter((r) => r.health.circuitState === "open").length ?? 0;
  const halfOpenCircuits = routes?.filter((r) => r.health.circuitState === "half_open").length ?? 0;

  return (
    <div className="space-y-5">
      {/* Header */}
      {!agentId && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Gateway Routing</h1>
            <p className="mt-1.5 max-w-xl text-sm leading-6 text-muted-foreground">
              Multi-vendor model routing with quota management, rate limiting, and circuit breaking.
            </p>
          </div>
          <Button size="sm" onClick={() => setShowCreateForm(true)} disabled={showCreateForm}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Route
          </Button>
        </div>
      )}

      {/* Stats tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="border border-border px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Routes</div>
          <div className="mt-1 flex items-center gap-1.5">
            <Network className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-lg font-semibold tabular-nums">{totalRoutes}</span>
            <span className="text-xs text-muted-foreground">({enabledRoutes} active)</span>
          </div>
        </div>
        <div className="border border-border px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Circuit Open</div>
          <div className="mt-1 flex items-center gap-1.5">
            <CircleOff className={cn("h-3.5 w-3.5", openCircuits > 0 ? "text-red-400" : "text-muted-foreground")} />
            <span className={cn("text-lg font-semibold tabular-nums", openCircuits > 0 && "text-red-400")}>{openCircuits}</span>
          </div>
        </div>
        <div className="border border-border px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Probing</div>
          <div className="mt-1 flex items-center gap-1.5">
            <Zap className={cn("h-3.5 w-3.5", halfOpenCircuits > 0 ? "text-amber-400" : "text-muted-foreground")} />
            <span className="text-lg font-semibold tabular-nums">{halfOpenCircuits}</span>
          </div>
        </div>
        <div className="border border-border px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Healthy</div>
          <div className="mt-1 flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-lg font-semibold tabular-nums">{enabledRoutes - openCircuits - halfOpenCircuits}</span>
          </div>
        </div>
      </div>

      {/* Inline agent add-route button */}
      {agentId && !showCreateForm && (
        <Button size="sm" variant="outline" onClick={() => setShowCreateForm(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add Route
        </Button>
      )}

      {/* Create form */}
      {showCreateForm && (
        <CreateRouteForm
          companyId={companyId}
          agentId={agentId}
          onCreated={() => setShowCreateForm(false)}
          onCancel={() => setShowCreateForm(false)}
        />
      )}

      {/* Route list grouped by priority */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 border border-border animate-pulse bg-muted/20" />
          ))}
        </div>
      ) : totalRoutes === 0 ? (
        <EmptyState
          icon={ArrowUpDown}
          message="No gateway routes configured. Add routes to enable multi-vendor model routing with automatic failover."
        />
      ) : (
        <div className="space-y-4">
          {groupedRoutes.map(([priority, group]) => (
            <div key={priority}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Priority {priority}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  ({group.length} route{group.length !== 1 ? "s" : ""})
                </span>
                {group.length > 1 && (
                  <span className="text-[10px] text-muted-foreground/60">
                    · weighted load balance
                  </span>
                )}
              </div>
              <div className="space-y-1">
                {group.map((route) => (
                  <RouteCard
                    key={route.id}
                    route={route}
                    companyId={companyId}
                    agentId={agentId}
                    onToggle={(enabled) => toggleMut.mutate({ routeId: route.id, isEnabled: enabled })}
                    onDelete={() => {
                      if (confirm(`Delete route "${route.name}"?`)) {
                        deleteMut.mutate(route.id);
                      }
                    }}
                    onResetCircuit={() => resetCircuitMut.mutate(route.id)}
                    isExpanded={expandedRoutes.has(route.id)}
                    onToggleExpand={() => toggleExpand(route.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
