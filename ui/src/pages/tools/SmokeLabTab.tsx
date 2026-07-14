import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Check,
  CircleSlash,
  FlaskConical,
  Loader2,
  Minus,
  Play,
  Power,
  RotateCcw,
  ServerCog,
  X,
} from "lucide-react";
import type { SmokeRun, SmokeRunStep } from "@paperclipai/shared";
import { smokeLabApi } from "@/api/smokeLab";
import { queryKeys } from "@/lib/queryKeys";
import { useToast } from "@/context/ToastContext";
import { useSmokeLabEnabled } from "@/hooks/useSmokeLabEnabled";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import {
  LIFECYCLE_STAGES,
  SMOKE_PATH_LABELS,
  SMOKE_PATHS,
  buildSmokeMatrix,
  cellKey,
  failingPaths,
  runHealth,
  type CellStatus,
} from "./smoke-lab-matrix";

// Public, non-secret fixture credentials for the fake OAuth provider. Kept in
// sync with SMOKE_LAB_DEMO_EMAIL / SMOKE_LAB_DEMO_PASSWORD in
// server/src/services/smoke-lab.ts — deterministic demo values, never real.
const DEMO_EMAIL = "smoke@paperclip.test";
const DEMO_PASSWORD = "smoke-password";

function formatTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value as string | Date);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function serviceTone(status: string): "success" | "warn" | "error" | "muted" {
  if (status === "running") return "success";
  if (status === "error") return "error";
  return "muted";
}

function CellGlyph({ status }: { status: CellStatus }) {
  if (status === "pass") return <Check className="mx-auto h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-label="pass" />;
  if (status === "fail") return <X className="mx-auto h-4 w-4 text-destructive" aria-label="fail" />;
  if (status === "skipped") return <Minus className="mx-auto h-4 w-4 text-amber-500" aria-label="skipped" />;
  return <span className="mx-auto block h-1.5 w-1.5 rounded-full bg-muted-foreground/30" aria-label="not run" />;
}

const HEALTH_STYLES: Record<string, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-destructive",
  unknown: "bg-muted-foreground/40",
};

export function SmokeLabTab({ companyId }: { companyId: string }) {
  const { enabled, loaded } = useSmokeLabEnabled();
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const servicesQuery = useQuery({
    queryKey: queryKeys.smokeLab.services(companyId),
    queryFn: () => smokeLabApi.listServices(companyId),
    enabled: enabled && loaded,
    refetchInterval: enabled ? 10_000 : false,
  });

  const runsQuery = useQuery({
    queryKey: queryKeys.smokeLab.runs(companyId),
    queryFn: () => smokeLabApi.listRuns(companyId),
    enabled: enabled && loaded,
    refetchInterval: enabled ? 10_000 : false,
  });

  const runs = runsQuery.data?.runs ?? [];
  const activeRunId = selectedRunId ?? runs[0]?.id ?? null;

  const runDetailQuery = useQuery({
    queryKey: queryKeys.smokeLab.run(companyId, activeRunId ?? "__none__"),
    queryFn: () => smokeLabApi.getRun(companyId, activeRunId!),
    enabled: enabled && loaded && !!activeRunId,
    refetchInterval: enabled && !!activeRunId ? 10_000 : false,
  });

  const steps = useMemo<SmokeRunStep[]>(() => runDetailQuery.data?.steps ?? [], [runDetailQuery.data]);
  const matrix = useMemo(() => buildSmokeMatrix(steps), [steps]);
  const activeRun = runDetailQuery.data?.run;

  function refresh() {
    qc.invalidateQueries({ queryKey: queryKeys.smokeLab.services(companyId) });
    qc.invalidateQueries({ queryKey: queryKeys.smokeLab.runs(companyId) });
    if (activeRunId) qc.invalidateQueries({ queryKey: queryKeys.smokeLab.run(companyId, activeRunId) });
  }

  const startMutation = useMutation({
    mutationFn: () => smokeLabApi.startServices(companyId),
    onSuccess: () => {
      pushToast({ title: "Smoke services started", tone: "success" });
      refresh();
    },
    onError: (e: Error) => pushToast({ title: "Couldn't start services", body: e.message, tone: "error" }),
  });

  const stopMutation = useMutation({
    mutationFn: () => smokeLabApi.stopServices(companyId),
    onSuccess: () => {
      pushToast({ title: "Smoke services stopped", tone: "info" });
      refresh();
    },
    onError: (e: Error) => pushToast({ title: "Couldn't stop services", body: e.message, tone: "error" }),
  });

  const installMutation = useMutation({
    mutationFn: () => smokeLabApi.installFixtures(companyId),
    onSuccess: (r) => {
      pushToast({
        title: r.created ? "Fixture apps installed" : "Fixture apps already present",
        tone: "success",
      });
      refresh();
    },
    onError: (e: Error) => pushToast({ title: "Couldn't install fixtures", body: e.message, tone: "error" }),
  });

  const resetMutation = useMutation({
    mutationFn: () => smokeLabApi.reset(companyId),
    onSuccess: () => {
      pushToast({ title: "Smoke Lab reset", tone: "info" });
      setSelectedRunId(null);
      refresh();
    },
    onError: (e: Error) => pushToast({ title: "Couldn't reset", body: e.message, tone: "error" }),
  });

  const runSmokeMutation = useMutation({
    mutationFn: () => smokeLabApi.createRun(companyId, { trigger: "manual", summary: {} }),
    onSuccess: (r) => {
      pushToast({
        title: "Smoke run started",
        body: "The browser runner records each step as it completes.",
        tone: "success",
      });
      setSelectedRunId(r.run.id);
      refresh();
    },
    onError: (e: Error) => pushToast({ title: "Couldn't start a run", body: e.message, tone: "error" }),
  });

  const anyMutating =
    startMutation.isPending ||
    stopMutation.isPending ||
    installMutation.isPending ||
    resetMutation.isPending ||
    runSmokeMutation.isPending;

  // Flag off — hidden. The server is authoritative; this is the friendly UX gate.
  if (loaded && !enabled) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex items-center gap-2 text-foreground">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Smoke Lab is turned off</h2>
        </div>
        <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">
          The Smoke Lab is an experimental developer surface for exercising the integration paths
          against deterministic local fixtures. Turn on <code className="rounded bg-muted px-1 py-0.5 text-xs">Smoke Lab</code>{" "}
          under Instance settings → Experimental to enable it.
        </p>
      </div>
    );
  }

  if (!loaded) {
    return <div className="p-6 text-sm text-muted-foreground">Loading Smoke Lab…</div>;
  }

  const services = servicesQuery.data?.services ?? [];
  const health = runHealth(activeRun, steps);
  const failing = failingPaths(steps);

  return (
    <div className="flex flex-col gap-6" data-testid="smoke-lab-tab">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-bold text-foreground">Smoke Lab</h1>
          <Badge variant="outline">Experimental</Badge>
          <a
            href="https://github.com/paperclipai/paperclip/blob/master/doc/connections/SMOKE-LAB-TUTORIAL.md"
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            <BookOpen className="h-4 w-4" /> Hands-on tutorial
          </a>
        </div>
        <p className="mt-1.5 max-w-3xl text-sm text-muted-foreground">
          Exercise every integration path (P1–P7) end-to-end against deterministic local fixtures —
          a fake OAuth provider and loopback MCP servers. Nothing here touches a real vendor or a
          real credential. Start the services, install the fixture apps, then drive the governed
          lifecycle from a browser smoke run. New here? Follow the{" "}
          <a
            href="https://github.com/paperclipai/paperclip/blob/master/doc/connections/SMOKE-LAB-TUTORIAL.md"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary hover:underline"
          >
            hands-on tutorial
          </a>
          .
        </p>
      </header>

      {/* Services */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ServerCog className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Fixture services</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => startMutation.mutate()}
              disabled={anyMutating}
            >
              <Power className="h-4 w-4" /> Start services
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => stopMutation.mutate()}
              disabled={anyMutating}
            >
              Stop
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => installMutation.mutate()}
              disabled={anyMutating}
            >
              Install fixture apps
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => resetMutation.mutate()}
              disabled={anyMutating}
            >
              <RotateCcw className="h-4 w-4" /> Reset
            </Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {services.map((service) => (
            <div key={service.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-foreground">{service.label}</p>
                  <p className="text-xs text-muted-foreground">{service.detail ?? service.id}</p>
                </div>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      service.status === "running"
                        ? "bg-emerald-500"
                        : service.status === "error"
                          ? "bg-destructive"
                          : "bg-muted-foreground/40",
                    )}
                  />
                  <span
                    className={cn(
                      serviceTone(service.status) === "success" && "text-emerald-600 dark:text-emerald-400",
                      serviceTone(service.status) === "error" && "text-destructive",
                      serviceTone(service.status) === "muted" && "text-muted-foreground",
                    )}
                  >
                    {service.status}
                  </span>
                </span>
              </div>
              <dl className="mt-3 space-y-1 text-xs">
                <div className="flex items-baseline gap-2">
                  <dt className="w-16 shrink-0 text-muted-foreground">URL</dt>
                  <dd className="min-w-0 break-all font-mono text-foreground">
                    {service.url ?? <span className="text-muted-foreground">not running</span>}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
          {services.length === 0 && (
            <p className="text-sm text-muted-foreground">No services reported. Start the fixture services above.</p>
          )}
        </div>

        {/* Demo credentials for the fake OAuth login */}
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3">
          <p className="text-xs font-semibold text-foreground">Fake OAuth demo credentials</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Type these into the fake provider's real consent page during a P1 (OAuth) smoke. Fixed
            fixture values — safe to show.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-foreground">
            <span>email: {DEMO_EMAIL}</span>
            <span>password: {DEMO_PASSWORD}</span>
          </div>
        </div>
      </section>

      {/* Results matrix */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Integration matrix</h2>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> pass</span>
            <span className="inline-flex items-center gap-1"><X className="h-3.5 w-3.5 text-destructive" /> fail</span>
            <span className="inline-flex items-center gap-1"><Minus className="h-3.5 w-3.5 text-amber-500" /> skipped</span>
            <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" /> not run</span>
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-semibold text-foreground">Path</th>
                {LIFECYCLE_STAGES.map((stage) => (
                  <th key={stage.key} className="px-2 py-2 text-center font-medium text-muted-foreground">
                    {stage.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SMOKE_PATHS.map((path) => (
                <tr key={path} className="border-b border-border last:border-0">
                  <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2 text-left">
                    <span className="font-mono font-semibold text-foreground">{path}</span>
                    <span className="ml-2 text-foreground">{SMOKE_PATH_LABELS[path].title}</span>
                    <span className="block text-(length:--text-micro) font-normal text-muted-foreground">
                      {SMOKE_PATH_LABELS[path].detail}
                    </span>
                  </th>
                  {LIFECYCLE_STAGES.map((stage) => {
                    const cell = matrix.get(cellKey(path, stage.key));
                    return (
                      <td key={stage.key} className="px-2 py-2 text-center">
                        <CellGlyph status={cell?.status ?? "not-run"} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {steps.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No steps recorded for the selected run yet. Run a browser smoke to populate the matrix.
          </p>
        )}
      </section>

      {/* Run history + drill-down */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Runs</h2>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn("h-2 w-2 rounded-full", HEALTH_STYLES[health])} />
              {health === "unknown" ? "no runs yet" : health}
              {failing.length > 0 && ` · failing: ${failing.join(", ")}`}
            </span>
          </div>
          <Button size="sm" onClick={() => runSmokeMutation.mutate()} disabled={anyMutating}>
            {runSmokeMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            Run browser smoke now
          </Button>
        </div>

        <div className="grid gap-4 lg:grid-cols-(--gtc-64)">
          <div className="rounded-lg border border-border">
            {runs.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">No runs recorded yet.</p>
            )}
            <ul className="divide-y divide-border">
              {runs.map((run: SmokeRun) => {
                const isActive = run.id === activeRunId;
                return (
                  <li key={run.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedRunId(run.id)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent/50",
                        isActive && "bg-accent",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block text-xs font-medium text-foreground">{formatTime(run.startedAt)}</span>
                        <span className="block text-(length:--text-micro) text-muted-foreground">{run.trigger}</span>
                      </span>
                      <StatusBadge status={run.status} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="min-w-0 rounded-lg border border-border">
            {!activeRun && (
              <p className="p-4 text-sm text-muted-foreground">Select a run to see its steps.</p>
            )}
            {activeRun && (
              <div className="flex flex-col">
                <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
                  <span className="text-xs text-muted-foreground">
                    Started {formatTime(activeRun.startedAt)} · finished {formatTime(activeRun.finishedAt)}
                  </span>
                  <StatusBadge status={activeRun.status} />
                </div>
                {steps.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">No steps recorded for this run.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {steps.map((step) => (
                      <li key={step.id} className="flex items-start gap-3 px-4 py-2.5">
                        <span className="mt-0.5">
                          {step.status === "pass" ? (
                            <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                          ) : step.status === "fail" ? (
                            <X className="h-4 w-4 text-destructive" />
                          ) : (
                            <CircleSlash className="h-4 w-4 text-amber-500" />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-foreground">
                            <span className="font-mono">{step.path}</span> · {step.scenarioStep}
                          </p>
                          {step.detail && (
                            <p className="mt-0.5 break-words text-(length:--text-micro) text-muted-foreground">{step.detail}</p>
                          )}
                          {step.screenshotArtifactRef && typeof step.screenshotArtifactRef.url === "string" && (
                            <a
                              href={step.screenshotArtifactRef.url}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1 inline-block text-(length:--text-micro) font-medium text-primary hover:underline"
                            >
                              View screenshot
                            </a>
                          )}
                        </div>
                        {typeof step.durationMs === "number" && (
                          <span className="shrink-0 text-(length:--text-micro) tabular-nums text-muted-foreground">
                            {step.durationMs}ms
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
