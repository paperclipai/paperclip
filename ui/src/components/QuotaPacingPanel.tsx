import { useEffect, useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_QUOTA_PACING_SETTINGS,
  QUOTA_PACING_MAX_SESSION_RESERVE_PERCENT,
  QUOTA_PACING_MAX_WEEKLY_ALLOWANCE_PERCENT,
  type PatchQuotaPacingSettings,
  type QuotaPacingMode,
  type QuotaPacingModeSetting,
  type QuotaPacingProviderState,
  type QuotaPacingReason,
  type QuotaPacingSettings,
  type QuotaPacingWindowState,
} from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { costsApi } from "@/api/costs";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { queryKeys } from "@/lib/queryKeys";
import { cn, providerDisplayName, relativeTime } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";

const MODE_OPTIONS: Array<{ value: QuotaPacingModeSetting; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "full", label: "Full" },
  { value: "half", label: "Half" },
  { value: "low", label: "Low" },
];

const MODE_BADGE: Record<QuotaPacingMode, { status: string; label: string }> = {
  full: { status: "ok", label: "Full pace" },
  half: { status: "warning", label: "Half pace" },
  low: { status: "error", label: "Low pace" },
};

const REASON_COPY: Record<QuotaPacingReason, string> = {
  disabled: "Pacing is off.",
  manual_override: "Manual mode is set.",
  no_data: "No quota data. Agents use their configured limit.",
  stale_data: "Quota data is out of date. Agents use their configured limit.",
  session_limit: "Session usage reached the reserve line.",
  weekly_limit: "Weekly usage reached 95%.",
  session_ahead: "Session usage is ahead of pace.",
  weekly_ahead: "Weekly usage is ahead of pace.",
  on_pace: "Usage is on pace.",
};

const PROVIDER_AGENTS: Record<string, string> = {
  anthropic: "Claude local agents",
  openai: "Codex local agents",
};

/** The pacing settings that the form edits. */
type PacingFields = Pick<QuotaPacingSettings, "mode" | "sessionReservePercent" | "weeklyAllowancePercent">;

interface PacingDraft {
  mode: QuotaPacingModeSetting;
  sessionReservePercent: string;
  weeklyAllowancePercent: string;
}

interface PacingForm {
  /** Server values the form was last synced to. A save sends only the fields that differ from them. */
  baseline: PacingFields;
  draft: PacingDraft;
}

interface ParsedDraft {
  mode: QuotaPacingModeSetting;
  /** Null when the input is not a valid percentage. */
  sessionReservePercent: number | null;
  /** Null when the input is not a valid percentage. */
  weeklyAllowancePercent: number | null;
}

const PACING_FIELDS = ["mode", "sessionReservePercent", "weeklyAllowancePercent"] as const;

function formFromSettings(settings: PacingFields): PacingForm {
  return {
    baseline: {
      mode: settings.mode,
      sessionReservePercent: settings.sessionReservePercent,
      weeklyAllowancePercent: settings.weeklyAllowancePercent,
    },
    draft: {
      mode: settings.mode,
      sessionReservePercent: String(settings.sessionReservePercent),
      weeklyAllowancePercent: String(settings.weeklyAllowancePercent),
    },
  };
}

/** A whole percent within 0..max, or null when the input is not one. */
function parseWholePercent(value: string, max: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed <= max ? parsed : null;
}

function parseDraft(draft: PacingDraft): ParsedDraft {
  return {
    mode: draft.mode,
    sessionReservePercent: parseWholePercent(draft.sessionReservePercent, QUOTA_PACING_MAX_SESSION_RESERVE_PERCENT),
    weeklyAllowancePercent: parseWholePercent(draft.weeklyAllowancePercent, QUOTA_PACING_MAX_WEEKLY_ALLOWANCE_PERCENT),
  };
}

/** Fields whose draft value differs from the baseline. An invalid percentage counts as edited. */
function editedFields(form: PacingForm): Set<keyof PacingFields> {
  const parsed = parseDraft(form.draft);
  return new Set(PACING_FIELDS.filter((field) => parsed[field] !== form.baseline[field]));
}

/**
 * The patch for this form: only the fields edited here, so a save never
 * sends values that another admin may have changed since the form loaded.
 * The server merges a partial `quotaPacing` key by key. Null when an
 * edited percentage is invalid.
 */
function pacingPatch(form: PacingForm): PatchQuotaPacingSettings | null {
  const parsed = parseDraft(form.draft);
  if (parsed.sessionReservePercent == null || parsed.weeklyAllowancePercent == null) return null;
  const edited = editedFields(form);
  return {
    ...(edited.has("mode") ? { mode: parsed.mode } : {}),
    ...(edited.has("sessionReservePercent") ? { sessionReservePercent: parsed.sessionReservePercent } : {}),
    ...(edited.has("weeklyAllowancePercent") ? { weeklyAllowancePercent: parsed.weeklyAllowancePercent } : {}),
  };
}

/**
 * Move the form onto newer server values. A field not edited here follows
 * the server; an edited field keeps its value, so the next save still sends
 * only what this form changed.
 */
function rebaseForm(form: PacingForm, server: PacingFields): PacingForm {
  const edited = editedFields(form);
  const next = formFromSettings(server);
  return {
    baseline: next.baseline,
    draft: {
      mode: edited.has("mode") ? form.draft.mode : next.draft.mode,
      sessionReservePercent: edited.has("sessionReservePercent")
        ? form.draft.sessionReservePercent
        : next.draft.sessionReservePercent,
      weeklyAllowancePercent: edited.has("weeklyAllowancePercent")
        ? form.draft.weeklyAllowancePercent
        : next.draft.weeklyAllowancePercent,
    },
  };
}

function formatResetTime(resetsAt: string): string {
  return new Date(resetsAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function fillClass(window: QuotaPacingWindowState): string {
  if (window.usedPercent >= 90) return "bg-(--status-task-blocked)";
  if (window.aheadPercent != null && window.aheadPercent > 0) return "bg-(--status-task-todo)";
  return "bg-primary/70";
}

function PaceBar({ label, window }: { label: string; window: QuotaPacingWindowState | null }) {
  if (!window) {
    return (
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">No data</span>
      </div>
    );
  }
  const used = Math.min(100, Math.max(0, window.usedPercent));
  const target = window.targetPercent == null ? null : Math.min(100, Math.max(0, window.targetPercent));
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{label}</div>
          {window.resetsAt ? (
            <div className="mt-1 text-xs text-muted-foreground">Resets {formatResetTime(window.resetsAt)}</div>
          ) : null}
        </div>
        <div className="shrink-0 text-right tabular-nums">
          <div className="text-sm font-semibold text-foreground">{used}% used</div>
          <div className="text-xs text-muted-foreground">
            {target == null ? "No pace target" : `Pace target ${target}%`}
          </div>
        </div>
      </div>
      <div className="relative">
        <div
          role="progressbar"
          aria-valuenow={Math.round(used)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={
            target == null ? `${label}: ${used}% used` : `${label}: ${used}% used, pace target ${target}%`
          }
          className="h-2 overflow-hidden bg-muted"
        >
          <div
            className={cn("h-full transition-(--tp-width) duration-200", fillClass(window))}
            style={{ width: `${used}%` }}
          />
        </div>
        {target != null ? (
          <div
            aria-hidden
            data-testid="pace-marker"
            className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 bg-foreground"
            style={{ left: `${target}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}

function ProviderPacing({ state }: { state: QuotaPacingProviderState }) {
  const badge = MODE_BADGE[state.mode];
  return (
    <div className="border border-border px-3.5 py-3" data-testid={`quota-pacing-${state.provider}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{providerDisplayName(state.provider)}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {PROVIDER_AGENTS[state.provider] ?? state.provider} · {REASON_COPY[state.reason]}
          </div>
        </div>
        <StatusBadge status={badge.status} label={badge.label} />
      </div>
      <div className="mt-3 space-y-3">
        <PaceBar label="Session window" window={state.session} />
        <PaceBar label="Weekly window" window={state.weekly} />
      </div>
      <div className="mt-3 text-xs text-muted-foreground">
        {state.lastPolledAt ? `Last quota data ${relativeTime(state.lastPolledAt)}` : "No quota data yet"}
      </div>
      {state.lastError ? (
        <div className="mt-1 break-words text-xs text-destructive">Last poll failed: {state.lastError}</div>
      ) : null}
    </div>
  );
}

/**
 * Instance-wide run pacing: settings plus the live mode per provider. Pacing
 * state is served through the company-scoped costs routes, so the panel takes
 * the selected company only to build that path.
 */
export function QuotaPacingPanel({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const fieldId = useId();
  const [form, setForm] = useState<PacingForm>(() => formFromSettings(DEFAULT_QUOTA_PACING_SETTINGS));
  const { draft } = form;
  const setDraft = (update: (current: PacingDraft) => PacingDraft) =>
    setForm((current) => ({ ...current, draft: update(current.draft) }));

  const settingsQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });
  const stateQuery = useQuery({
    queryKey: queryKeys.usageQuotaPacing(companyId),
    queryFn: () => costsApi.quotaPacing(companyId),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });

  const settings = settingsQuery.data?.quotaPacing ?? null;
  useEffect(() => {
    if (settings) setForm((current) => rebaseForm(current, settings));
  }, [settings?.mode, settings?.sessionReservePercent, settings?.weeklyAllowancePercent]);

  const updateMutation = useMutation({
    mutationFn: (patch: PatchQuotaPacingSettings) => instanceSettingsApi.updateGeneral({ quotaPacing: patch }),
    onSuccess: async (updated) => {
      // Sync the baseline to the stored values at once, so the next save
      // diffs against them and not against the values this form loaded.
      setForm((current) => rebaseForm(current, updated.quotaPacing));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.usageQuotaPacing(companyId) }),
      ]);
    },
  });

  // The server enforces instance-admin writes. Only lock the controls when
  // the current access is known and is not an instance admin.
  const canManage = !boardAccess || boardAccess.source === "local_implicit" || boardAccess.isInstanceAdmin;
  const editable = Boolean(settings) && canManage && !updateMutation.isPending;
  const { sessionReservePercent: sessionReserve, weeklyAllowancePercent: weeklyAllowance } = parseDraft(draft);
  const patch = pacingPatch(form);
  const canSave = editable && patch != null && Object.keys(patch).length > 0;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || !patch) return;
    updateMutation.mutate(patch);
  }

  const enabled = settings?.enabled === true;
  const state = stateQuery.data ?? null;
  const loadError = settingsQuery.error ?? stateQuery.error;
  const saveError = updateMutation.error;

  return (
    <section className="border border-border px-4 py-4" aria-labelledby={`${fieldId}-title`}>
      <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <h3
            id={`${fieldId}-title`}
            className="text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground"
          >
            Run pacing
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Run pacing lowers how many runs Claude and Codex local agents start at once when subscription usage
            gets ahead of an even pace, so the 5-hour and weekly windows last and interactive sessions keep headroom.
          </p>
        </div>
        <ToggleSwitch
          checked={enabled}
          onCheckedChange={(next) => updateMutation.mutate({ enabled: next })}
          disabled={!editable}
          aria-label="Toggle run pacing"
        />
      </div>

      {settingsQuery.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading run pacing…</p>
      ) : null}

      {loadError ? (
        <div className="mt-4 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {loadError instanceof Error ? loadError.message : "Failed to load run pacing."}
        </div>
      ) : null}

      <form className="mt-4 space-y-3" onSubmit={handleSubmit}>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-mode`}>Mode</Label>
            <Select
              value={draft.mode}
              onValueChange={(mode) => setDraft((current) => ({ ...current, mode: mode as QuotaPacingModeSetting }))}
              disabled={!editable}
            >
              <SelectTrigger id={`${fieldId}-mode`} className="w-full" aria-label="Pacing mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-session-reserve`}>Session reserve (%)</Label>
            <Input
              id={`${fieldId}-session-reserve`}
              type="number"
              inputMode="numeric"
              min={0}
              max={QUOTA_PACING_MAX_SESSION_RESERVE_PERCENT}
              step={1}
              value={draft.sessionReservePercent}
              onChange={(event) => setDraft((current) => ({ ...current, sessionReservePercent: event.target.value }))}
              aria-invalid={sessionReserve == null}
              disabled={!editable}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-weekly-allowance`}>Weekly allowance (%)</Label>
            <Input
              id={`${fieldId}-weekly-allowance`}
              type="number"
              inputMode="numeric"
              min={0}
              max={QUOTA_PACING_MAX_WEEKLY_ALLOWANCE_PERCENT}
              step={1}
              value={draft.weeklyAllowancePercent}
              onChange={(event) => setDraft((current) => ({ ...current, weeklyAllowancePercent: event.target.value }))}
              aria-invalid={weeklyAllowance == null}
              disabled={!editable}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Auto follows the quota windows. Session reserve keeps part of the 5-hour window free for interactive use
          (0–{QUOTA_PACING_MAX_SESSION_RESERVE_PERCENT}%). Weekly allowance is how far weekly usage may run ahead of an
          even pace (0–{QUOTA_PACING_MAX_WEEKLY_ALLOWANCE_PERCENT}%). Running work is never stopped.
        </p>
        {sessionReserve == null || weeklyAllowance == null ? (
          <p className="text-xs text-destructive">Enter whole percentages within the ranges above.</p>
        ) : null}
        {saveError ? (
          <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {saveError instanceof Error ? saveError.message : "Failed to save run pacing."}
          </div>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {canManage
              ? `Quota is checked every ${Math.round((settings?.pollIntervalSec ?? DEFAULT_QUOTA_PACING_SETTINGS.pollIntervalSec) / 60)} min while pacing is on.`
              : "Only instance admins can change run pacing."}
          </p>
          <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={!canSave}>
            {updateMutation.isPending ? "Saving…" : "Save pacing"}
          </Button>
        </div>
      </form>

      {state && enabled ? (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {state.providers.map((provider) => (
            <ProviderPacing key={provider.provider} state={provider} />
          ))}
        </div>
      ) : null}
      {state && !enabled ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Pacing is off. Agents use their configured concurrent-run limit.
        </p>
      ) : null}
      {state?.lastError && enabled ? (
        <div className="mt-3 break-words text-xs text-destructive">Last quota poll failed: {state.lastError}</div>
      ) : null}
    </section>
  );
}
