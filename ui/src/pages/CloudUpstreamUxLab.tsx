import { useMemo } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  ExternalLink,
  FileJson,
  History,
  Loader2,
  RefreshCcw,
  ShieldAlert,
} from "lucide-react";
import type {
  CloudUpstreamActivationDecision,
  CloudUpstreamActivationEntityType,
  CloudUpstreamConflict,
  CloudUpstreamConnection,
  CloudUpstreamPreview,
  CloudUpstreamRun,
  CloudUpstreamStep,
  CloudUpstreamSummaryCount,
  CloudUpstreamWarning,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLocation } from "@/lib/router";

type FixtureStateKey =
  | "settings-pane"
  | "connect-wizard"
  | "schema-mismatch"
  | "preview"
  | "preview-clean"
  | "progress"
  | "retry"
  | "finish";

const STEPS: Array<{ key: CloudUpstreamStep; label: string }> = [
  { key: "connect", label: "Connect" },
  { key: "scan", label: "Scan" },
  { key: "preview", label: "Preview" },
  { key: "push", label: "Push" },
  { key: "verify", label: "Verify" },
  { key: "activate", label: "Activate" },
];

const ACTIVATION_CATEGORIES: Array<{
  key: CloudUpstreamActivationEntityType;
  label: string;
  singular: string;
  detail: string;
}> = [
  {
    key: "agents",
    label: "Agents",
    singular: "agent",
    detail: "Keep paused until cloud secrets and adapter credentials are verified.",
  },
  {
    key: "routines",
    label: "Routines",
    singular: "routine",
    detail: "Review schedules before enabling triggers.",
  },
  {
    key: "monitors",
    label: "Monitors",
    singular: "monitor",
    detail: "Activate after the target instance has been smoke tested.",
  },
];

const FIXTURE_LABELS: Record<FixtureStateKey, string> = {
  "settings-pane": "1 · Settings → Cloud upstream pane (enabled)",
  "connect-wizard": "2 · Connect wizard — remote URL entry + PKCE launch",
  "schema-mismatch": "3 · Connect wizard — schema-mismatch hard block",
  preview: "4 · Preview — conflicts, warnings, planned actions",
  "preview-clean": "5 · Preview — clean run with no conflicts",
  progress: "6 · Durable progress — mid-run from run events",
  retry: "7 · Retry without duplicating ledger entries",
  finish: "8 · Finish / activation checklist with run report",
};

const PARSE_ORDER: FixtureStateKey[] = [
  "settings-pane",
  "connect-wizard",
  "schema-mismatch",
  "preview",
  "preview-clean",
  "progress",
  "retry",
  "finish",
];

export function CloudUpstreamUxLab() {
  const location = useLocation();
  const { state, showChrome } = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const raw = (params.get("state") ?? "settings-pane") as FixtureStateKey;
    return {
      state: PARSE_ORDER.includes(raw) ? raw : "settings-pane",
      showChrome: params.get("chrome") === "on",
    };
  }, [location.search]);

  const fixture = useMemo(() => buildFixture(state), [state]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      {showChrome ? <FixtureNav active={state} /> : null}
      <CloudUpstreamRender fixture={fixture} />
    </div>
  );
}

function FixtureNav({ active }: { active: FixtureStateKey }) {
  return (
    <div className="rounded-md border border-dashed border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <div className="mb-1 font-semibold uppercase tracking-wide">UX lab · cloud upstream</div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {PARSE_ORDER.map((key) => (
          <a
            key={key}
            href={`?state=${key}`}
            className={
              active === key
                ? "rounded bg-primary/10 px-2 py-0.5 font-medium text-primary"
                : "rounded px-2 py-0.5 hover:bg-accent/40"
            }
          >
            {FIXTURE_LABELS[key]}
          </a>
        ))}
      </div>
    </div>
  );
}

interface Fixture {
  selectedCompanyName: string;
  connection: CloudUpstreamConnection | null;
  preview: CloudUpstreamPreview | null;
  latestRun: CloudUpstreamRun | null;
  history: CloudUpstreamRun[];
  notice: string | null;
  actionError: string | null;
}

function CloudUpstreamRender({ fixture }: { fixture: Fixture }) {
  const { connection, preview, latestRun, history, notice, actionError, selectedCompanyName } = fixture;
  const activeStep: CloudUpstreamStep = latestRun?.activeStep
    ?? (preview ? "preview" : connection?.tokenStatus === "connected" ? "scan" : "connect");
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <CloudUpload className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Cloud upstream</h1>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Push {selectedCompanyName} into a Paperclip Cloud stack. Automations stay paused until activation.
          </p>
        </div>
        {connection?.target.origin ? (
          <Button variant="outline" size="sm" asChild>
            <a href={connection.target.origin} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
              Open cloud
            </a>
          </Button>
        ) : null}
      </div>

      {notice ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      ) : null}
      {actionError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <Stepper activeStep={activeStep} />

      <section className="space-y-3">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Connection</div>
        <div className="rounded-md border border-border px-4 py-4">
          {connection ? (
            <div className="grid gap-3 lg:grid-cols-(--gtc-17) lg:items-start">
              <div>
                <div className="text-sm font-medium">
                  {connection.target.stackDisplayName ?? connection.target.stackSlug ?? connection.target.stackId}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {connection.target.product} · {connection.target.origin} · token {connection.tokenStatus}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Schema {connection.target.schemaMajor}. Max chunk {formatBytes(connection.target.maxChunkBytes)}.
                </div>
              </div>
              <Button variant="outline" size="sm">
                <RefreshCcw className="h-4 w-4" />
                Preview push
              </Button>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-(--gtc-17)">
              <Input
                defaultValue="https://paperclip.paperclip.app/PC521D/dashboard"
                placeholder="https://paperclip.paperclip.app/PC521D/dashboard"
                aria-label="Paperclip Cloud stack URL"
                autoFocus
              />
              <Button disabled>
                <Loader2 className="h-4 w-4 animate-spin" />
                Discovering
              </Button>
            </div>
          )}
        </div>
      </section>

      {preview ? (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Preview</div>
            <Button disabled={!preview.schemaCompatible}>
              <CloudUpload className="h-4 w-4" />
              Push to cloud
            </Button>
          </div>
          <SummaryGrid summary={preview.summary} />
          <WarningsPanel warnings={preview.warnings} />
          <ConflictTable conflicts={preview.conflicts} />
        </section>
      ) : null}

      {latestRun ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Progress and finish</div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm">
                <FileJson className="h-4 w-4" />
                Download report
              </Button>
              {latestRun.status === "failed" || latestRun.status === "cancelled" ? (
                <Button variant="outline" size="sm">
                  <RefreshCcw className="h-4 w-4" />
                  Retry
                </Button>
              ) : latestRun.status === "succeeded" ? (
                <Button variant="outline" size="sm">
                  <RefreshCcw className="h-4 w-4" />
                  Re-run
                </Button>
              ) : null}
            </div>
          </div>
          <div className="rounded-md border border-border px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium capitalize">{latestRun.status}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Run {latestRun.id.slice(0, 8)} · {latestRun.completedAt
                    ? `completed ${formatDate(latestRun.completedAt)}`
                    : latestRun.status === "running"
                      ? "in progress"
                      : "in progress"}
                </div>
              </div>
              <div className="text-sm tabular-nums">{latestRun.progressPercent}%</div>
            </div>
            <div className="mt-3 h-2 rounded-full bg-muted">
              <div className="h-2 rounded-full bg-primary" style={{ width: `${latestRun.progressPercent}%` }} />
            </div>
            <div className="mt-4 divide-y divide-border">
              {latestRun.events.map((event) => (
                <div key={event.id} className="grid gap-2 py-2 text-sm sm:grid-cols-(--gtc-20)">
                  <span className="text-xs text-muted-foreground">{formatDate(event.at)}</span>
                  <span className="text-xs capitalize text-muted-foreground">{event.phase}</span>
                  <span>{event.message}</span>
                </div>
              ))}
            </div>
          </div>

          {latestRun.status === "succeeded" ? <ActivationChecklist run={latestRun} /> : null}
        </section>
      ) : null}

      {history.length ? (
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <History className="h-3.5 w-3.5" />
            History
          </div>
          <div className="divide-y divide-border rounded-md border border-border">
            {history.map((run) => (
              <div
                key={run.id}
                className="grid w-full gap-1 px-4 py-3 text-left text-sm hover:bg-accent/40 sm:grid-cols-(--gtc-17)"
              >
                <span>Run {run.id.slice(0, 8)} · {run.status}</span>
                <span className="text-xs text-muted-foreground">{formatDate(run.createdAt)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Stepper({ activeStep }: { activeStep: CloudUpstreamStep }) {
  const activeIndex = STEPS.findIndex((step) => step.key === activeStep);
  return (
    <div className="grid gap-2 rounded-md border border-border px-3 py-3 sm:grid-cols-6">
      {STEPS.map((step, index) => {
        const complete = index < activeIndex;
        const active = index === activeIndex;
        return (
          <div key={step.key} className="flex items-center gap-2 text-xs">
            {complete ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <span className={active ? "h-4 w-4 rounded-full border-2 border-primary" : "h-4 w-4 rounded-full border border-border"} />
            )}
            <span className={active ? "font-medium text-foreground" : "text-muted-foreground"}>{step.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function SummaryGrid({ summary }: { summary: CloudUpstreamSummaryCount[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-4">
      {summary.map((item) => (
        <div key={item.key} className="rounded-md border border-border px-3 py-2">
          <div className="text-lg font-semibold tabular-nums">{item.count}</div>
          <div className="text-xs text-muted-foreground">{item.label}</div>
        </div>
      ))}
    </div>
  );
}

function WarningsPanel({ warnings }: { warnings: CloudUpstreamWarning[] }) {
  return (
    <div className="rounded-md border border-border px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <ShieldAlert className="h-4 w-4 text-muted-foreground" />
        Warnings
      </div>
      <div className="divide-y divide-border">
        {warnings.map((warning) => (
          <div key={warning.code} className="grid gap-2 py-2 sm:grid-cols-(--gtc-21)">
            <AlertTriangle className={warning.severity === "blocker" ? "h-4 w-4 text-destructive" : "h-4 w-4 text-amber-600"} />
            <div className="text-sm font-medium">{warning.title}</div>
            <div className="text-sm text-muted-foreground">{warning.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConflictTable({ conflicts }: { conflicts: CloudUpstreamConflict[] }) {
  return (
    <div className="rounded-md border border-border px-4 py-3">
      <div className="mb-2 text-sm font-medium">Conflicts</div>
      {conflicts.length === 0 ? (
        <div className="text-sm text-muted-foreground">No target conflicts detected for this preview.</div>
      ) : (
        <div className="divide-y divide-border">
          {conflicts.map((conflict) => (
            <div key={conflict.id} className="grid gap-2 py-2 text-sm sm:grid-cols-(--gtc-22)">
              <span className="text-muted-foreground">{conflict.entityType}</span>
              <span>{conflict.sourceLabel}</span>
              <span>{conflict.targetLabel}</span>
              <span className="capitalize">{conflict.plannedAction}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivationChecklist({ run }: { run: CloudUpstreamRun }) {
  const rows = buildActivationRows(run);
  return (
    <div className="rounded-md border border-border px-4 py-3">
      <div className="mb-2 text-sm font-medium">Activation checklist</div>
      <div className="divide-y divide-border">
        {rows.map((row) => {
          const activated = row.status === "activated";
          return (
            <div key={row.key} className="grid gap-2 py-2 text-sm sm:grid-cols-(--gtc-23) sm:items-center">
              <div>
                <div className="font-medium">{row.label}</div>
                <div className="text-xs text-muted-foreground">{row.statusLabel}</div>
              </div>
              <div className="text-muted-foreground">
                {row.count === 0 ? `0 imported ${row.pluralLabel} in this run.` : row.detail}
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Button variant={activated ? "secondary" : "default"} size="sm" disabled={row.count === 0 || activated}>
                  {activated ? "Activated" : "Activate"}
                </Button>
                <Button variant="ghost" size="sm" disabled={activated}>
                  Keep paused
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function buildActivationRows(run: CloudUpstreamRun) {
  const decisions = decisionsFromReport(run.report);
  return ACTIVATION_CATEGORIES.map((category) => {
    const decision = decisions[category.key];
    const count = summaryCount(run.summary, category.key);
    const status = decision?.status === "activated" ? "activated" : "paused";
    const pluralLabel = `${category.singular}${count === 1 ? "" : "s"}`;
    return {
      ...category,
      count,
      pluralLabel,
      status,
      detail: `${count} imported ${pluralLabel} are paused by default. ${category.detail}`,
      statusLabel: status === "activated"
        ? `${count} activated`
        : count === 0
          ? "0 imported"
          : `${count} paused`,
    };
  });
}

function decisionsFromReport(report: Record<string, unknown>): Partial<Record<CloudUpstreamActivationEntityType, CloudUpstreamActivationDecision>> {
  const value = optionalRecord(report.activationChecklist);
  const decisions: Partial<Record<CloudUpstreamActivationEntityType, CloudUpstreamActivationDecision>> = {};
  for (const key of ["agents", "routines", "monitors"] as const) {
    const item = optionalRecord(value[key]);
    if (!item) continue;
    decisions[key] = {
      entityType: key,
      count: typeof item.count === "number" ? item.count : 0,
      status: item.status === "activated" ? "activated" : "paused",
      activatedAt: typeof item.activatedAt === "string" ? item.activatedAt : null,
    };
  }
  return decisions;
}

function summaryCount(summary: CloudUpstreamSummaryCount[], key: CloudUpstreamActivationEntityType): number {
  return summary.find((item) => item.key === key)?.count ?? 0;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function formatDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024))} MiB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KiB`;
  return `${value} B`;
}

const STACK_TARGET = {
  stackId: "stk_2vKqz9D8mNFqQ7Rp",
  stackSlug: "paperclip-prod",
  stackDisplayName: "Paperclip Prod",
  companyId: "co_4hT2yX",
  primaryHost: "paperclip.paperclip.app",
  origin: "https://paperclip.paperclip.app",
  product: "paperclip-cloud",
  schemaMajor: 7,
  maxChunkBytes: 5 * 1024 * 1024,
};

const STACK_TARGET_SCHEMA_BEHIND = {
  ...STACK_TARGET,
  schemaMajor: 5,
};

function connectedConnection(target = STACK_TARGET): CloudUpstreamConnection {
  return {
    id: "cu_conn_8d3f1b6a",
    companyId: "co_4hT2yX",
    remoteUrl: "https://paperclip.paperclip.app/PC521D/dashboard",
    target,
    tokenStatus: "connected",
    scopes: ["upstream.push", "upstream.preview"],
    authorizedGlobalUserId: "user_9pXqYzAbCdEf",
    expiresAt: "2026-08-18T19:00:00.000Z",
    createdAt: "2026-05-18T18:45:00.000Z",
    updatedAt: "2026-05-18T19:02:18.000Z",
    lastRunId: null,
  };
}

const PREVIEW_SUMMARY: CloudUpstreamSummaryCount[] = [
  { key: "users", label: "Users", count: 14 },
  { key: "agents", label: "Agents", count: 6 },
  { key: "routines", label: "Routines", count: 4 },
  { key: "monitors", label: "Monitors", count: 2 },
];

const PREVIEW_WARNINGS_NORMAL: CloudUpstreamWarning[] = [
  {
    code: "imported_automations_paused",
    severity: "warning",
    title: "Automations stay paused",
    detail: "Imported agents, routines, and monitors require explicit activation after the push.",
  },
  {
    code: "unmatched_users_import_as_historical_authors",
    severity: "warning",
    title: "Unmatched users become historical authors",
    detail: "Invite now remains a secondary action after the transfer is complete.",
  },
  {
    code: "secret_values_redacted",
    severity: "warning",
    title: "Secret values are not transferred",
    detail: "The push carries secret requirements only. Configure cloud secrets before activating automations.",
  },
];

const PREVIEW_WARNINGS_SCHEMA: CloudUpstreamWarning[] = [
  {
    code: "schema_mismatch",
    severity: "blocker",
    title: "Cloud stack upgrade required",
    detail: "This local build uses upstream schema 7, but the cloud stack reports schema 5.",
  },
  ...PREVIEW_WARNINGS_NORMAL,
];

const PREVIEW_CONFLICTS: CloudUpstreamConflict[] = [
  {
    id: "conflict_user_serena",
    entityType: "user",
    sourceLabel: "serena@magicmachine.co (unmatched)",
    targetLabel: "→ historical author Serena R.",
    plannedAction: "create",
    reason: "Target stack has no matching identity. Will arrive as historical author; invite available after push.",
  },
  {
    id: "conflict_user_dotta",
    entityType: "user",
    sourceLabel: "dotta@magicmachine.co",
    targetLabel: "↦ dotta@magicmachine.co (cloud)",
    plannedAction: "update",
    reason: "Existing cloud identity matches local user; will be merged.",
  },
  {
    id: "conflict_agent_qa",
    entityType: "agent",
    sourceLabel: "QA · qa-bot",
    targetLabel: "↦ QA · qa-bot (cloud)",
    plannedAction: "update",
    reason: "Mapped to existing cloud agent. Imported run history will be appended.",
  },
  {
    id: "conflict_routine_nightly_reports",
    entityType: "routine",
    sourceLabel: "Nightly status report",
    targetLabel: "(new in cloud)",
    plannedAction: "create",
    reason: "Routine does not exist in the target stack and will be created in paused state.",
  },
];

function basePreview(): CloudUpstreamPreview {
  return {
    connectionId: "cu_conn_8d3f1b6a",
    sourceCompanyId: "co_local_pc521d",
    target: STACK_TARGET,
    schemaCompatible: true,
    summary: PREVIEW_SUMMARY,
    warnings: PREVIEW_WARNINGS_NORMAL,
    conflicts: PREVIEW_CONFLICTS,
    generatedAt: "2026-05-18T19:03:14.000Z",
  };
}

function schemaMismatchPreview(): CloudUpstreamPreview {
  return {
    ...basePreview(),
    target: STACK_TARGET_SCHEMA_BEHIND,
    schemaCompatible: false,
    summary: [],
    conflicts: [],
    warnings: PREVIEW_WARNINGS_SCHEMA,
  };
}

function cleanPreview(): CloudUpstreamPreview {
  return {
    ...basePreview(),
    conflicts: [],
    warnings: PREVIEW_WARNINGS_NORMAL.slice(0, 1),
  };
}

const PROGRESS_EVENTS = [
  { id: "evt_01", at: "2026-05-18T19:10:02.000Z", phase: "scan" as CloudUpstreamStep, type: "completed" as const, message: "Scanned 14 users, 6 agents, 4 routines, 2 monitors." },
  { id: "evt_02", at: "2026-05-18T19:10:11.000Z", phase: "preview" as CloudUpstreamStep, type: "completed" as const, message: "Preview generated with 4 conflicts and 3 warnings." },
  { id: "evt_03", at: "2026-05-18T19:10:31.000Z", phase: "push" as CloudUpstreamStep, type: "created" as const, message: "users · 8 created, 6 mapped to existing identities." },
  { id: "evt_04", at: "2026-05-18T19:10:48.000Z", phase: "push" as CloudUpstreamStep, type: "updated" as const, message: "agents · 4 created paused, 2 updated paused." },
  { id: "evt_05", at: "2026-05-18T19:10:58.000Z", phase: "push" as CloudUpstreamStep, type: "updated" as const, message: "routines · 3 created paused, 1 updated." },
  { id: "evt_06", at: "2026-05-18T19:11:09.000Z", phase: "push" as CloudUpstreamStep, type: "created" as const, message: "monitors · 2 created paused." },
  { id: "evt_07", at: "2026-05-18T19:11:18.000Z", phase: "verify" as CloudUpstreamStep, type: "updated" as const, message: "Verifying transferred ledger checksums…" },
];

function runningRun(): CloudUpstreamRun {
  return {
    id: "run_3kQ8mNpW9bX2zL4Y",
    connectionId: "cu_conn_8d3f1b6a",
    companyId: "co_local_pc521d",
    status: "running",
    activeStep: "push",
    progressPercent: 62,
    dryRun: false,
    summary: PREVIEW_SUMMARY,
    warnings: PREVIEW_WARNINGS_NORMAL,
    conflicts: PREVIEW_CONFLICTS,
    events: PROGRESS_EVENTS,
    targetUrl: "https://paperclip.paperclip.app/PC521D/dashboard",
    report: {},
    retryOfRunId: null,
    createdAt: "2026-05-18T19:10:01.000Z",
    updatedAt: "2026-05-18T19:11:18.000Z",
    completedAt: null,
  };
}

function failedRun(): CloudUpstreamRun {
  return {
    id: "run_5fXqR2bT7aD8zP1K",
    connectionId: "cu_conn_8d3f1b6a",
    companyId: "co_local_pc521d",
    status: "failed",
    activeStep: "push",
    progressPercent: 78,
    dryRun: false,
    summary: PREVIEW_SUMMARY,
    warnings: PREVIEW_WARNINGS_NORMAL,
    conflicts: PREVIEW_CONFLICTS,
    events: [
      ...PROGRESS_EVENTS,
      {
        id: "evt_08",
        at: "2026-05-18T19:11:30.000Z",
        phase: "push",
        type: "failed",
        message: "Apply rejected: cloud rejected chunk 4 of 6 (HTTP 502). Ledger entries from chunks 1–3 retained; chunk 4 not committed.",
      },
    ],
    targetUrl: "https://paperclip.paperclip.app/PC521D/dashboard",
    report: { ledgerCheckpoint: "chunk-3" },
    retryOfRunId: null,
    createdAt: "2026-05-18T19:10:01.000Z",
    updatedAt: "2026-05-18T19:11:30.000Z",
    completedAt: null,
  };
}

function succeededRun(): CloudUpstreamRun {
  return {
    id: "run_7aBcD9eFgH2iJ3kL",
    connectionId: "cu_conn_8d3f1b6a",
    companyId: "co_local_pc521d",
    status: "succeeded",
    activeStep: "activate",
    progressPercent: 100,
    dryRun: false,
    summary: PREVIEW_SUMMARY,
    warnings: PREVIEW_WARNINGS_NORMAL,
    conflicts: PREVIEW_CONFLICTS,
    events: [
      ...PROGRESS_EVENTS,
      {
        id: "evt_08",
        at: "2026-05-18T19:11:25.000Z",
        phase: "verify",
        type: "completed",
        message: "Ledger checksums match. Push committed.",
      },
      {
        id: "evt_09",
        at: "2026-05-18T19:11:31.000Z",
        phase: "activate",
        type: "completed",
        message: "Activation checklist pending operator approval — automations remain paused.",
      },
    ],
    targetUrl: "https://paperclip.paperclip.app/PC521D/dashboard",
    report: {
      activationChecklist: {
        agents: { count: 6, status: "paused", activatedAt: null },
        routines: { count: 4, status: "paused", activatedAt: null },
        monitors: { count: 2, status: "paused", activatedAt: null },
      },
    },
    retryOfRunId: null,
    createdAt: "2026-05-18T19:10:01.000Z",
    updatedAt: "2026-05-18T19:11:31.000Z",
    completedAt: "2026-05-18T19:11:31.000Z",
  };
}

function buildFixture(state: FixtureStateKey): Fixture {
  switch (state) {
    case "settings-pane":
      return {
        selectedCompanyName: "Paperclip · PC521D",
        connection: connectedConnection(),
        preview: null,
        latestRun: null,
        history: [],
        notice: "Cloud upstream connection approved.",
        actionError: null,
      };
    case "connect-wizard":
      return {
        selectedCompanyName: "Paperclip · PC521D",
        connection: null,
        preview: null,
        latestRun: null,
        history: [],
        notice: null,
        actionError: null,
      };
    case "schema-mismatch":
      return {
        selectedCompanyName: "Paperclip · PC521D",
        connection: connectedConnection(STACK_TARGET_SCHEMA_BEHIND),
        preview: schemaMismatchPreview(),
        latestRun: null,
        history: [],
        notice: null,
        actionError: "Cloud stack is on schema 5 but this local build pushes schema 7. Upgrade the cloud stack to continue.",
      };
    case "preview":
      return {
        selectedCompanyName: "Paperclip · PC521D",
        connection: connectedConnection(),
        preview: basePreview(),
        latestRun: null,
        history: [],
        notice: null,
        actionError: null,
      };
    case "preview-clean":
      return {
        selectedCompanyName: "Paperclip · PC521D",
        connection: connectedConnection(),
        preview: cleanPreview(),
        latestRun: null,
        history: [],
        notice: "Preview completed. No target conflicts detected.",
        actionError: null,
      };
    case "progress":
      return {
        selectedCompanyName: "Paperclip · PC521D",
        connection: connectedConnection(),
        preview: null,
        latestRun: runningRun(),
        history: [],
        notice: null,
        actionError: null,
      };
    case "retry":
      return {
        selectedCompanyName: "Paperclip · PC521D",
        connection: connectedConnection(),
        preview: null,
        latestRun: failedRun(),
        history: [
          { ...failedRun(), id: "run_9pYqXwVtSrQ" },
        ],
        notice: null,
        actionError: "Push run failed. Review the events. Retry resumes from ledger checkpoint chunk-3 — chunks 1–3 will not be re-applied.",
      };
    case "finish":
      return {
        selectedCompanyName: "Paperclip · PC521D",
        connection: connectedConnection(),
        preview: null,
        latestRun: succeededRun(),
        history: [
          { ...succeededRun(), id: "run_aZcXvBnMqWeR" },
        ],
        notice: "Push run completed. Review activation before unpausing automations.",
        actionError: null,
      };
  }
}
