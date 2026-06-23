import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "@/lib/router";
import { useState, useEffect } from "react";
import { plansApi } from "../../api/plans";
import { useToastActions } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { formatTokens } from "../../lib/utils";
import { planFirstTierTicketCount } from "../../lib/hive-board";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PlanGateRollup } from "./PlanGateRollup";
import { PlanSupervisionTimeline } from "./PlanSupervisionTimeline";

interface PlanDetailDrawerProps {
  companyId: string | null;
}

// Driven by the ?plan=<issueId> search param so plan deep-links are shareable.
// Shows tiers/phases + per-tier child status counts, the budget cap (editable
// while draft), and the Activate action.
export function PlanDetailDrawer({ companyId }: PlanDetailDrawerProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const planId = searchParams.get("plan");
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [capDraft, setCapDraft] = useState("");
  const [etaDraft, setEtaDraft] = useState("");

  const { data: plan } = useQuery({
    queryKey: queryKeys.hive.plan(planId!),
    queryFn: () => plansApi.get(planId!),
    enabled: !!planId,
  });

  useEffect(() => {
    setCapDraft(plan?.planDetails.budgetCapTokens?.toString() ?? "");
  }, [plan?.planDetails.budgetCapTokens]);

  useEffect(() => {
    setEtaDraft(isoToLocalInput(plan?.planDetails.estimatedCompletionAt ?? null));
  }, [plan?.planDetails.estimatedCompletionAt]);

  const close = () =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("plan");
      return next;
    });

  const invalidate = () => {
    if (planId) queryClient.invalidateQueries({ queryKey: queryKeys.hive.plan(planId) });
    if (companyId) queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
  };

  const activate = useMutation({
    mutationFn: () => plansApi.activate(planId!),
    onSuccess: (r) => {
      pushToast({ title: "Plan activated", body: `${r.childIssueIds.length} ticket(s) opened.`, tone: "success" });
      invalidate();
    },
    onError: (e) => pushToast({ title: "Activation failed", body: errMsg(e), tone: "error" }),
  });

  const saveBudget = useMutation({
    mutationFn: () => {
      const trimmed = capDraft.trim();
      const tokens = trimmed === "" ? null : Math.max(0, Math.floor(Number(trimmed)));
      return plansApi.setBudget(planId!, { budgetCapTokens: tokens });
    },
    onSuccess: () => {
      pushToast({ title: "Budget cap saved", tone: "success" });
      invalidate();
      if (companyId) queryClient.invalidateQueries({ queryKey: queryKeys.budgets.liveMeter(companyId) });
    },
    onError: (e) => pushToast({ title: "Could not save cap", body: errMsg(e), tone: "error" }),
  });

  const saveEstimate = useMutation({
    mutationFn: () =>
      plansApi.setEstimate(planId!, {
        estimatedCompletionAt: etaDraft.trim() === "" ? null : localInputToIso(etaDraft),
      }),
    onSuccess: () => {
      pushToast({ title: "ETA saved", tone: "success" });
      invalidate();
    },
    onError: (e) => pushToast({ title: "Could not save ETA", body: errMsg(e), tone: "error" }),
  });

  const capDirty = capDraft.trim() !== (plan?.planDetails.budgetCapTokens?.toString() ?? "");
  const capInvalid = capDraft.trim() !== "" && !Number.isFinite(Number(capDraft.trim()));
  const etaCurrent = isoToLocalInput(plan?.planDetails.estimatedCompletionAt ?? null);
  const etaDirty = etaDraft !== etaCurrent;

  const statusOf = (childId: string) =>
    plan?.childStatuses.find((c) => c.id === childId)?.status ?? null;

  const state = plan?.planDetails.state ?? "draft";
  // Activate only materializes the first tier's requested children server-side;
  // gate the button on that so empty drafts can't trigger a failing activation.
  const canActivate = planFirstTierTicketCount(plan?.planDetails.tiers) > 0;

  return (
    <Sheet open={!!planId} onOpenChange={(o) => { if (!o) close(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        {plan ? (
          <>
            <SheetHeader>
              <SheetTitle>{plan.issue.title}</SheetTitle>
              <SheetDescription className="flex items-center gap-2 capitalize">
                State: {state}
                {plan.planDetails.gateEnforcement === "strict" && (
                  <span
                    title="Hard gates active — implementors cannot start until plan-approval is approved"
                    className="inline-flex items-center rounded-full border border-amber-400/50 bg-amber-50/60 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-300/40 dark:bg-amber-400/10 dark:text-amber-300"
                  >
                    strict gates
                  </span>
                )}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-5 px-4 pb-6">
              {plan.issue.description && (
                <p className="text-sm text-muted-foreground">{plan.issue.description}</p>
              )}

              {planId && <PlanGateRollup companyId={companyId} planIssueId={planId} />}

              {planId && (
                <PlanSupervisionTimeline planIssueId={planId} planState={state} />
              )}

              {/* Budget cap */}
              <div className="space-y-1.5">
                <Label htmlFor="cap-tokens">Token budget cap</Label>
                <div className="flex gap-2">
                  <Input
                    id="cap-tokens"
                    type="number"
                    min={0}
                    value={capDraft}
                    onChange={(e) => setCapDraft(e.target.value)}
                    placeholder="No cap"
                  />
                  <Button
                    variant="outline"
                    onClick={() => saveBudget.mutate()}
                    disabled={saveBudget.isPending || !capDirty || capInvalid}
                  >
                    {saveBudget.isPending ? "Saving…" : "Save"}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  When total tokens under this plan cross the cap, the plan auto-stops.
                  {plan.planDetails.budgetCapTokens
                    ? ` Current cap: ${formatTokens(plan.planDetails.budgetCapTokens)} tok.`
                    : ""}
                </p>
              </div>

              {/* Estimated completion (ETA) */}
              <div className="space-y-1.5">
                <Label htmlFor="plan-eta">Estimated completion</Label>
                <div className="flex gap-2">
                  <Input
                    id="plan-eta"
                    type="datetime-local"
                    value={etaDraft}
                    onChange={(e) => setEtaDraft(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    onClick={() => saveEstimate.mutate()}
                    disabled={saveEstimate.isPending || !etaDirty}
                  >
                    {saveEstimate.isPending ? "Saving…" : "Save"}
                  </Button>
                  {etaDraft.trim() !== "" && (
                    <Button
                      variant="ghost"
                      onClick={() => setEtaDraft("")}
                      disabled={saveEstimate.isPending}
                    >
                      Clear
                    </Button>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  When the plan passes this time, the CTO is woken to review overrun.
                  {plan.planDetails.estimatedCompletionAt
                    ? ` Current: ${new Date(plan.planDetails.estimatedCompletionAt).toLocaleString()}.`
                    : ""}
                </p>
              </div>

              {/* Tiers */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Phases
                </h3>
                {plan.planDetails.tiers.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No phases yet.{state === "draft" ? " Add tasks before activating." : ""}
                  </p>
                )}
                {plan.planDetails.tiers.map((tier) => (
                  <div key={tier.id} className="rounded-md border border-border p-2.5">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-sm font-medium">{tier.name}</span>
                      <span className="text-[10px] uppercase text-muted-foreground">{tier.kind}</span>
                    </div>
                    <ul className="space-y-1">
                      {tier.childIssueIds.length > 0
                        ? tier.childIssueIds.map((cid) => (
                            <li key={cid} className="flex items-center gap-2 text-xs">
                              <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
                                {(statusOf(cid) ?? "—").replace(/_/g, " ")}
                              </span>
                              <span className="truncate font-mono text-muted-foreground">{cid.slice(0, 8)}</span>
                            </li>
                          ))
                        : tier.requestedChildren.map((c, i) => (
                            <li key={i} className="text-xs text-muted-foreground">
                              • {String((c as { title?: string }).title ?? "Untitled task")}
                            </li>
                          ))}
                    </ul>
                  </div>
                ))}
              </div>

              {state === "draft" && (
                <div className="space-y-1.5">
                  <Button
                    className="w-full"
                    onClick={() => activate.mutate()}
                    disabled={activate.isPending || !canActivate}
                  >
                    {activate.isPending ? "Activating…" : "Activate plan"}
                  </Button>
                  {!canActivate && (
                    <p className="text-[11px] text-muted-foreground">
                      Add at least one first-phase task before activating.
                    </p>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <SheetHeader>
            <SheetTitle>Loading…</SheetTitle>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

// <input type="datetime-local"> works in local time with no timezone suffix.
// Convert the stored UTC ISO string to a local "YYYY-MM-DDTHH:mm" value and back.
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(local: string): string {
  // `new Date("YYYY-MM-DDTHH:mm")` parses as local time; toISOString normalizes to UTC.
  return new Date(local).toISOString();
}
