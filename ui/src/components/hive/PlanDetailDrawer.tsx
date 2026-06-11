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

  const { data: plan } = useQuery({
    queryKey: queryKeys.hive.plan(planId!),
    queryFn: () => plansApi.get(planId!),
    enabled: !!planId,
  });

  useEffect(() => {
    setCapDraft(plan?.planDetails.budgetCapTokens?.toString() ?? "");
  }, [plan?.planDetails.budgetCapTokens]);

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
              <SheetDescription className="capitalize">State: {state}</SheetDescription>
            </SheetHeader>

            <div className="space-y-5 px-4 pb-6">
              {plan.issue.description && (
                <p className="text-sm text-muted-foreground">{plan.issue.description}</p>
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
                  {plan.planDetails.budgetCapTokens ? (
                    <span className="self-center whitespace-nowrap text-xs text-muted-foreground">
                      {formatTokens(plan.planDetails.budgetCapTokens)} tok
                    </span>
                  ) : null}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  When total tokens under this plan cross the cap, the plan auto-stops.
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
