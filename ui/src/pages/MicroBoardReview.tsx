import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, ClipboardCheck, FileText, PauseCircle, RotateCcw, ShieldCheck } from "lucide-react";
import type { MicroRegistryExperiment, MicroRegistryOverview } from "@paperclipai/shared";
import { dashboardApi } from "../api/dashboard";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { boardReviewDecisionLabel, boardReviewQueue, formatExperimentWindow, type MicroBoardReviewDecision } from "../lib/micro-registry";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Textarea } from "@/components/ui/textarea";

function metricsFlag(experiment: MicroRegistryExperiment, key: string) {
  const value = experiment.metrics?.[key];
  return value === true ? "yes" : value === false ? "no" : "unset";
}

function evidenceCount(registry: MicroRegistryOverview, experimentId: string) {
  return registry.evidencePacks.filter((pack) => pack.experimentId === experimentId).length;
}

function resolvedGateCount(registry: MicroRegistryOverview, experimentId: string) {
  return registry.dependencyRequests.filter((gate) => gate.experimentId === experimentId && gate.status === "resolved").length;
}

const decisions: Array<{ decision: MicroBoardReviewDecision; icon: typeof CheckCircle2; tone: string; description: string }> = [
  {
    decision: "approve_local_dry_run_plan",
    icon: CheckCircle2,
    tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    description: "Marks the experiment approved for local dry-run preparation only. It does not run CPS or touch compute/brokers.",
  },
  {
    decision: "needs_revision",
    icon: RotateCcw,
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    description: "Sends the experiment back to the pods for more preregistration/evidence work.",
  },
  {
    decision: "hold",
    icon: PauseCircle,
    tone: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
    description: "Keeps the experiment gated at board review with no next action.",
  },
];

export function MicroBoardReview() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    setBreadcrumbs([
      { label: "Dashboard", href: "/dashboard" },
      { label: "Micro Board Review" },
    ]);
  }, [setBreadcrumbs]);

  const { data: registry, isLoading } = useQuery({
    queryKey: [...queryKeys.dashboard(selectedCompanyId!), "micro-registry", "board-review"],
    queryFn: () => dashboardApi.microRegistry(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 30_000,
  });

  const reviewQueue = useMemo(() => registry ? boardReviewQueue(registry) : [], [registry]);

  const reviewMutation = useMutation({
    mutationFn: ({ experiment, decision }: { experiment: MicroRegistryExperiment; decision: MicroBoardReviewDecision }) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return dashboardApi.recordMicroBoardReview(selectedCompanyId, experiment.id, {
        decision,
        note: notes[experiment.id]?.trim() || null,
      });
    },
    onSuccess: (updated) => {
      if (selectedCompanyId) {
        void queryClient.invalidateQueries({ queryKey: [...queryKeys.dashboard(selectedCompanyId), "micro-registry"] });
        void queryClient.invalidateQueries({ queryKey: [...queryKeys.dashboard(selectedCompanyId), "micro-registry", "board-review"] });
      }
      pushToast({
        title: "Board review recorded",
        body: `${updated.identifier} moved to ${updated.lifecycleState}. Execution remains disabled until a separate approval gate.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({ title: "Could not record board review", body: error instanceof Error ? error.message : "Unknown error", tone: "error" });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={ClipboardCheck} message="Select a company to review micro experiments." />;
  }

  if (isLoading || !registry) {
    return <PageSkeleton variant="dashboard" />;
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <section className="overflow-hidden rounded-[2rem] border border-slate-900/10 bg-[radial-gradient(circle_at_20%_20%,rgba(20,184,166,0.18),transparent_35%),linear-gradient(135deg,#07111f,#102034_55%,#152018)] p-6 text-white shadow-2xl">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs uppercase tracking-[0.24em] text-emerald-100">
              <ShieldCheck className="h-3.5 w-3.5" /> CEO gate / no execution
            </div>
            <h1 className="text-3xl font-semibold tracking-tight md:text-5xl">Micro board review</h1>
            <p className="mt-3 text-sm leading-6 text-slate-200 md:text-base">
              Review experiments whose planning gates are resolved. These actions only update registry state; they do not launch CPS, Vast, brokers, paid APIs, paper orders, or live trading.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
              <div className="text-3xl font-semibold">{reviewQueue.length}</div>
              <div className="text-xs uppercase tracking-wide text-slate-300">ready</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
              <div className="text-3xl font-semibold">{registry.dependencyRequests.filter((gate) => gate.status === "resolved").length}</div>
              <div className="text-xs uppercase tracking-wide text-slate-300">gates</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
              <div className="text-3xl font-semibold">{registry.promotionRequests.length}</div>
              <div className="text-xs uppercase tracking-wide text-slate-300">promotions</div>
            </div>
          </div>
        </div>
      </section>

      {reviewQueue.length === 0 ? (
        <div className="flex flex-col gap-4">
          <EmptyState icon={ClipboardCheck} message="No experiments are waiting for board review." />
          {registry.experiments.length > 0 && (
            <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
              <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Pipeline — what will arrive here
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Experiments enter this queue when they reach <code className="rounded bg-muted px-1.5 py-0.5 text-xs">ready_for_board_review</code>.
                Current registry state:
              </p>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                {registry.experiments.map((experiment) => {
                  const openGates = registry.dependencyRequests.filter(
                    (gate) => gate.experimentId === experiment.id && gate.status !== "resolved",
                  ).length;
                  return (
                    <div key={experiment.id} className="rounded-2xl border border-border bg-muted/40 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{experiment.identifier}</div>
                          <div className="mt-1 font-medium text-foreground">{experiment.title}</div>
                        </div>
                        <span className="shrink-0 rounded-full bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-700 dark:text-sky-300">
                          {experiment.lifecycleState.replaceAll("_", " ")}
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
                        <span>Open gates: {openGates}</span>
                        <span>Resolved gates: {resolvedGateCount(registry, experiment.id)}</span>
                        <span>Evidence packs: {evidenceCount(registry, experiment.id)}</span>
                        <span>
                          Improvements: {experiment.improvementAttemptCount}/{experiment.maxImprovementAttempts}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {reviewQueue.map((experiment) => (
            <article key={experiment.id} className="rounded-3xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{experiment.identifier}</div>
                  <h2 className="mt-1 text-xl font-semibold text-foreground">{experiment.title}</h2>
                </div>
                <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                  {experiment.lifecycleState.replaceAll("_", " ")}
                </span>
              </div>

              <p className="mt-4 text-sm leading-6 text-muted-foreground">{experiment.hypothesis}</p>

              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl bg-muted/60 p-3">
                  <div className="text-xs text-muted-foreground">Holding window</div>
                  <div className="font-medium">{formatExperimentWindow(experiment)}</div>
                </div>
                <div className="rounded-2xl bg-muted/60 p-3">
                  <div className="text-xs text-muted-foreground">Resolved gates</div>
                  <div className="font-medium">{resolvedGateCount(registry, experiment.id)}</div>
                </div>
                <div className="rounded-2xl bg-muted/60 p-3">
                  <div className="text-xs text-muted-foreground">Evidence packs</div>
                  <div className="font-medium">{evidenceCount(registry, experiment.id)}</div>
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-dashed border-border p-3 text-sm">
                <div className="flex items-center gap-2 font-medium"><FileText className="h-4 w-4" /> Safety flags</div>
                <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                  <span>Execution: {metricsFlag(experiment, "executionAuthorized")}</span>
                  <span>Paid compute: {metricsFlag(experiment, "paidComputeAuthorized")}</span>
                  <span>Broker: {metricsFlag(experiment, "brokerActionsAuthorized")}</span>
                </div>
              </div>

              <Textarea
                value={notes[experiment.id] ?? ""}
                onChange={(event) => setNotes((current) => ({ ...current, [experiment.id]: event.target.value }))}
                placeholder="Optional board note: what is approved, what stays blocked, or what must be revised."
                className="mt-4 min-h-24"
              />

              <div className="mt-4 grid gap-3">
                {decisions.map(({ decision, icon: Icon, tone, description }) => (
                  <button
                    key={decision}
                    type="button"
                    disabled={reviewMutation.isPending}
                    onClick={() => reviewMutation.mutate({ experiment, decision })}
                    className={`group rounded-2xl border p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 ${tone}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <Icon className="h-5 w-5" />
                        <div className="font-semibold">{boardReviewDecisionLabel(decision)}</div>
                      </div>
                      <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
                    </div>
                    <p className="mt-2 text-xs opacity-80">{description}</p>
                  </button>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
