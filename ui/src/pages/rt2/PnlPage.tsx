import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Coins, Database, DollarSign, MessageSquare, Receipt, ShieldAlert, TrendingUp, Users, XCircle } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageSkeleton } from "../../components/PageSkeleton";
import { rt2EconomyApi, type Rt2SettlementThresholdSettings } from "../../api/rt2-economy";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";

const formatGold = (value: number) => `${value.toLocaleString()} G`;

export function PnlPage() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [selectedActor, setSelectedActor] = useState<{ actorId: string; actorType: "user" | "agent" } | null>(null);
  const [settlementDraft, setSettlementDraft] = useState<Record<string, { finalPriceGold: string; comment: string; decisionReason: string }>>({});
  const [thresholdDraft, setThresholdDraft] = useState<Partial<Record<keyof Rt2SettlementThresholdSettings, string>>>({});

  useEffect(() => {
    setBreadcrumbs([{ label: "P&L" }]);
  }, [setBreadcrumbs]);

  const summary = useQuery({
    queryKey: ["rt2-pnl-summary", selectedCompanyId],
    queryFn: () => rt2EconomyApi.getPnlSummary(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const rows = useQuery({
    queryKey: ["rt2-pnl-rows", selectedCompanyId],
    queryFn: () => rt2EconomyApi.listPnlRows(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const pnlRows = rows.data ?? [];
  const activeActor = useMemo(() => selectedActor ?? (pnlRows[0]
    ? { actorId: pnlRows[0].actorId, actorType: pnlRows[0].actorType }
    : null), [pnlRows, selectedActor]);

  const drilldown = useQuery({
    queryKey: ["rt2-pnl-drilldown", selectedCompanyId, activeActor?.actorId, activeActor?.actorType],
    queryFn: () => rt2EconomyApi.getPnlDrilldown(selectedCompanyId!, activeActor!.actorId, activeActor!.actorType),
    enabled: Boolean(selectedCompanyId && activeActor),
  });

  const settlements = useQuery({
    queryKey: ["rt2-pnl-settlements", selectedCompanyId],
    queryFn: () => rt2EconomyApi.getSettlementOverview(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  useEffect(() => {
    if (!settlements.data?.thresholds) return;
    setThresholdDraft(Object.fromEntries(
      Object.entries(settlements.data.thresholds).map(([key, value]) => [key, String(value)]),
    ) as Partial<Record<keyof Rt2SettlementThresholdSettings, string>>);
  }, [settlements.data?.thresholds]);

  const invalidateSettlementData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["rt2-pnl-settlements", selectedCompanyId] }),
      queryClient.invalidateQueries({ queryKey: ["rt2-pnl-summary", selectedCompanyId] }),
      queryClient.invalidateQueries({ queryKey: ["rt2-pnl-rows", selectedCompanyId] }),
      queryClient.invalidateQueries({ queryKey: ["rt2-pnl-drilldown"] }),
    ]);
  };

  const addComment = useMutation({
    mutationFn: ({ id, comment }: { id: string; comment: string }) =>
      rt2EconomyApi.addSettlementComment(selectedCompanyId!, id, comment),
    onSuccess: invalidateSettlementData,
  });

  const approveSettlement = useMutation({
    mutationFn: ({ id, finalPriceGold, decisionReason }: { id: string; finalPriceGold?: number; decisionReason?: string }) =>
      rt2EconomyApi.approveSettlement(selectedCompanyId!, id, { finalPriceGold, decisionReason }),
    onSuccess: invalidateSettlementData,
  });

  const rejectSettlement = useMutation({
    mutationFn: ({ id, decisionReason }: { id: string; decisionReason: string }) =>
      rt2EconomyApi.rejectSettlement(selectedCompanyId!, id, decisionReason),
    onSuccess: invalidateSettlementData,
  });

  const updateThresholds = useMutation({
    mutationFn: (input: Partial<Rt2SettlementThresholdSettings>) =>
      rt2EconomyApi.updateSettlementThresholds(selectedCompanyId!, input),
    onSuccess: invalidateSettlementData,
  });

  if (!selectedCompany) {
    return <EmptyState icon={DollarSign} message="Select a company to open P&L." />;
  }

  if (summary.isLoading || rows.isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (summary.error || rows.error) {
    return <p className="text-sm text-destructive">{((summary.error ?? rows.error) as Error).message}</p>;
  }

  const data = summary.data;
  const evidence = data?.calculationEvidence;

  return (
    <div className="space-y-6">
      <section className="border border-border bg-card px-6 py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase text-muted-foreground">P&amp;L</div>
            <h1 className="text-2xl font-semibold tracking-tight">{selectedCompany.name} amoeba ledger</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              승인된 deliverable 평가와 coin ledger를 합산해 사람/에이전트별 수익, 비용, 순손익을 보여줍니다.
            </p>
          </div>
          <div className="text-sm text-muted-foreground">{data?.ledgerEntryCount ?? 0} ledger entries</div>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-4">
        <MetricCard icon={TrendingUp} label="Income" value={formatGold(data?.totalIncome ?? 0)} />
        <MetricCard icon={Receipt} label="Expenses" value={formatGold(data?.totalExpenses ?? 0)} />
        <MetricCard icon={DollarSign} label="Net P&L" value={formatGold(data?.netPnL ?? 0)} />
        <MetricCard icon={Users} label="Active Actors" value={(data?.activeActors ?? 0).toLocaleString()} />
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="border border-border bg-card px-5 py-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
            <Database className="h-4 w-4" />
            Settlement evidence
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <StatusBadge status={evidence?.settlementStatus ?? "missing"} />
            <span className="border border-border px-2 py-1 text-muted-foreground">Period {evidence?.period ?? "-"}</span>
            <span className="border border-border px-2 py-1 text-muted-foreground">
              Approved {evidence?.approvedDeliverableCount ?? 0}
            </span>
            <span className="border border-border px-2 py-1 text-muted-foreground">
              Ledger {evidence?.ledgerEntryCount ?? 0}
            </span>
          </div>
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {(evidence?.sourceTables ?? []).map((source) => (
              <div key={source} className="border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                {source}
              </div>
            ))}
          </div>
          {(evidence?.warnings ?? []).length > 0 ? (
            <div className="mt-3 space-y-1 text-xs text-amber-600">
              {evidence!.warnings.map((warning) => <p key={warning}>{warning}</p>)}
            </div>
          ) : null}
        </div>

        <div className="border border-border bg-card px-5 py-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
            <Coins className="h-4 w-4" />
            Ledger types
          </div>
          <div className="mt-3 space-y-2 text-sm">
            {Object.keys(evidence?.ledgerByType ?? {}).length === 0 ? (
              <p className="text-muted-foreground">No ledger entries.</p>
            ) : (
              Object.entries(evidence!.ledgerByType).map(([type, count]) => (
                <div key={type} className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{type}</span>
                  <span className="font-medium">{count}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="border border-border bg-card">
        <div className="flex flex-col gap-3 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
              <ShieldAlert className="h-4 w-4" />
              Settlement governance
            </div>
            <h2 className="mt-1 text-sm font-semibold">가격 협상, 승인, anti-gaming 검토</h2>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="border border-border px-2 py-1">Total {settlements.data?.summary.total ?? 0}</span>
            <span className="border border-border px-2 py-1">Approval {settlements.data?.summary.approvalRequired ?? 0}</span>
            <span className="border border-border px-2 py-1">High risk {settlements.data?.summary.highRisk ?? 0}</span>
          </div>
        </div>
        {settlements.data?.thresholds ? (
          <div className="border-b border-border px-5 py-4">
            <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
              <ThresholdInput label="High value" value={thresholdDraft.highValueGold} onChange={(value) => setThresholdDraft((current) => ({ ...current, highValueGold: value }))} />
              <ThresholdInput label="Self-review critical" value={thresholdDraft.selfReviewCriticalCount} onChange={(value) => setThresholdDraft((current) => ({ ...current, selfReviewCriticalCount: value }))} />
              <ThresholdInput label="Earned count" value={thresholdDraft.goldFarmingEarnedCount} onChange={(value) => setThresholdDraft((current) => ({ ...current, goldFarmingEarnedCount: value }))} />
              <ThresholdInput label="Warning gold" value={thresholdDraft.goldFarmingWarningGold} onChange={(value) => setThresholdDraft((current) => ({ ...current, goldFarmingWarningGold: value }))} />
              <ThresholdInput label="Critical gold" value={thresholdDraft.goldFarmingCriticalGold} onChange={(value) => setThresholdDraft((current) => ({ ...current, goldFarmingCriticalGold: value }))} />
              <ThresholdInput label="Quality score" value={thresholdDraft.qualityBiasAutoScore} onChange={(value) => setThresholdDraft((current) => ({ ...current, qualityBiasAutoScore: value }))} />
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-muted-foreground">
                Signal thresholds apply per company and affect newly refreshed settlement risk gates.
              </div>
              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 border border-border px-3 py-2 text-xs hover:bg-muted"
                onClick={() => {
                  const next: Partial<Rt2SettlementThresholdSettings> = {};
                  for (const [key, value] of Object.entries(thresholdDraft)) {
                    const parsed = Number(value);
                    if (Number.isFinite(parsed) && parsed > 0) {
                      next[key as keyof Rt2SettlementThresholdSettings] = parsed;
                    }
                  }
                  updateThresholds.mutate(next);
                }}
                disabled={updateThresholds.isPending}
              >
                <ShieldAlert className="h-3.5 w-3.5" />
                {updateThresholds.isPending ? "Saving..." : "Save thresholds"}
              </button>
            </div>
          </div>
        ) : null}
        {settlements.isLoading ? (
          <div className="px-5 py-5 text-sm text-muted-foreground">정산 후보를 계산하는 중입니다.</div>
        ) : (settlements.data?.settlements ?? []).length === 0 ? (
          <div className="px-5 py-5 text-sm text-muted-foreground">검토할 approved deliverable settlement가 없습니다.</div>
        ) : (
          <div className="divide-y divide-border">
            {settlements.data!.settlements.map((item) => {
              const draft = settlementDraft[item.id] ?? { finalPriceGold: "", comment: "", decisionReason: "" };
              const setDraft = (next: Partial<typeof draft>) =>
                setSettlementDraft((current) => ({ ...current, [item.id]: { ...draft, ...next } }));
              return (
                <div key={item.id} className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
                  <div className="min-w-0 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{item.workProductId}</span>
                      <SettlementStatus status={item.status} riskLevel={item.riskLevel} />
                      {item.approvalRequired ? (
                        <span className="border border-amber-500/30 px-2 py-1 text-xs text-amber-600">
                          Approval gate
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm text-muted-foreground">{item.rationale}</p>
                    <div className="grid gap-2 text-xs md:grid-cols-3">
                      <Amount label="Proposed" value={item.proposedPriceGold} />
                      <Amount label="Final" value={item.finalPriceGold ?? item.proposedPriceGold} />
                      <div>
                        <div className="text-xs text-muted-foreground">Owner</div>
                        <div className="truncate text-sm font-medium">{item.ownerActorId}</div>
                      </div>
                    </div>
                    {item.antiGamingSignals.length > 0 ? (
                      <div className="space-y-2">
                        {item.antiGamingSignals.map((signal) => (
                          <div key={signal.key} className="border border-border bg-background px-3 py-2 text-xs">
                            <div className="font-medium">{signal.label} · {signal.severity}</div>
                            <div className="mt-1 text-muted-foreground">{signal.evidence}</div>
                            {signal.thresholdBasis ? (
                              <div className="mt-1 text-muted-foreground">Threshold: {signal.thresholdBasis}</div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground">Anti-gaming signal 없음</div>
                    )}
                    {item.negotiationComments.length > 0 ? (
                      <div className="space-y-1 text-xs text-muted-foreground">
                        {item.negotiationComments.slice(-2).map((comment) => (
                          <p key={`${comment.actorId}:${comment.createdAt}`}>
                            {comment.actorId}: {comment.comment}
                          </p>
                        ))}
                      </div>
                    ) : null}
                    {item.ledgerEvidence ? (
                      <div className="grid gap-2 border border-emerald-500/30 bg-background px-3 py-2 text-xs md:grid-cols-4">
                        <div>
                          <div className="text-muted-foreground">Ledger</div>
                          <div className="truncate font-medium">{item.ledgerEvidence.id.slice(0, 8)}</div>
                        </div>
                        <Amount label="Amount" value={item.ledgerEvidence.amount} />
                        <Amount label="Balance after" value={item.ledgerEvidence.balanceAfter} />
                        <div>
                          <div className="text-muted-foreground">Period</div>
                          <div className="font-medium">{item.ledgerEvidence.period}</div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground">Ledger entry is created after approval.</div>
                    )}
                  </div>
                  <div className="space-y-2">
                    <input
                      className="w-full border border-border bg-background px-3 py-2 text-sm"
                      placeholder="Final gold"
                      value={draft.finalPriceGold}
                      onChange={(event) => setDraft({ finalPriceGold: event.target.value })}
                    />
                    <textarea
                      className="min-h-20 w-full border border-border bg-background px-3 py-2 text-sm"
                      placeholder="협상 코멘트 또는 승인/반려 근거"
                      value={draft.comment || draft.decisionReason}
                      onChange={(event) => setDraft({ comment: event.target.value, decisionReason: event.target.value })}
                    />
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        className="inline-flex items-center justify-center gap-1 border border-border px-2 py-2 text-xs hover:bg-muted"
                        onClick={() => addComment.mutate({ id: item.id, comment: draft.comment.trim() })}
                        disabled={!draft.comment.trim() || addComment.isPending}
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                        Comment
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center justify-center gap-1 border border-emerald-500/30 px-2 py-2 text-xs text-emerald-600 hover:bg-muted"
                        onClick={() => approveSettlement.mutate({
                          id: item.id,
                          finalPriceGold: draft.finalPriceGold ? Number(draft.finalPriceGold) : undefined,
                          decisionReason: draft.decisionReason.trim() || undefined,
                        })}
                        disabled={item.status === "approved" || approveSettlement.isPending}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Approve
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center justify-center gap-1 border border-destructive/30 px-2 py-2 text-xs text-destructive hover:bg-muted"
                        onClick={() => rejectSettlement.mutate({ id: item.id, decisionReason: draft.decisionReason.trim() })}
                        disabled={!draft.decisionReason.trim() || item.status === "rejected" || rejectSettlement.isPending}
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        Reject
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold">Actor Drilldown</h2>
            <p className="text-sm text-muted-foreground">
              Approved deliverable revenue: {formatGold(data?.approvedDeliverableRevenue ?? 0)} from{" "}
              {data?.approvedDeliverableCount ?? 0} deliverables
            </p>
          </div>
          <div className="divide-y divide-border">
            {pnlRows.length === 0 ? (
              <div className="px-5 py-6 text-sm text-muted-foreground">
                승인된 deliverable 또는 ledger row가 아직 없습니다.
              </div>
            ) : (
              pnlRows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="grid w-full gap-3 px-5 py-4 text-left hover:bg-muted/40 md:grid-cols-[1fr_8rem_8rem_8rem] md:items-center"
                  onClick={() => setSelectedActor({ actorId: row.actorId, actorType: row.actorType })}
                >
                  <div>
                    <div className="text-sm font-medium">{row.actorId}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.actorType} · {row.period}
                    </div>
                  </div>
                  <Amount label="Income" value={row.income} />
                  <Amount label="Expenses" value={row.expenses} />
                  <Amount label="Net" value={row.netPnL} />
                </button>
              ))
            )}
          </div>
        </div>

        <div className="border border-border bg-card p-5">
          <h2 className="text-sm font-semibold">Top Earners</h2>
          <div className="mt-4 space-y-3">
            {(data?.topEarners ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">수익이 기록된 actor가 없습니다.</p>
            ) : (
              data!.topEarners.map((earner) => (
                <div key={`${earner.actorType}:${earner.actorId}`} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{earner.actorId}</div>
                    <div className="text-xs text-muted-foreground">{earner.actorType}</div>
                  </div>
                  <div className="text-sm font-medium">{formatGold(earner.income)}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {activeActor ? (
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="border border-border bg-card">
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-sm font-semibold">Approved deliverable basis</h2>
              <p className="text-sm text-muted-foreground">
                {activeActor.actorId} · {drilldown.data?.approvedDeliverables.length ?? 0} approved deliverables
              </p>
            </div>
            <div className="divide-y divide-border">
              {(drilldown.data?.approvedDeliverables ?? []).length === 0 ? (
                <div className="px-5 py-5 text-sm text-muted-foreground">선택한 actor의 승인 산출물 근거가 없습니다.</div>
              ) : (
                drilldown.data!.approvedDeliverables.map((item) => (
                  <div key={item.workProductId} className="grid gap-2 px-5 py-3 text-sm md:grid-cols-[minmax(0,1fr)_5rem_5rem]">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{item.title}</div>
                      <div className="text-xs text-muted-foreground">{item.type} · {item.approvalMode ?? "review"}</div>
                    </div>
                    <Amount label="Gold" value={item.revenue} />
                    <Amount label="Quality" value={item.qualityScore} />
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="border border-border bg-card">
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-sm font-semibold">Coin ledger evidence</h2>
              <p className="text-sm text-muted-foreground">
                {drilldown.data?.ledgerEntries.length ?? 0} entries for selected period
              </p>
            </div>
            <div className="divide-y divide-border">
              {(drilldown.data?.ledgerEntries ?? []).length === 0 ? (
                <div className="px-5 py-5 text-sm text-muted-foreground">선택한 actor의 coin ledger가 없습니다.</div>
              ) : (
                drilldown.data!.ledgerEntries.slice(0, 8).map((entry) => (
                  <div key={entry.id} className="grid gap-2 px-5 py-3 text-sm md:grid-cols-[minmax(0,1fr)_6rem]">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{entry.description ?? entry.transactionType}</div>
                      <div className="text-xs text-muted-foreground">
                        {entry.transactionType} · {entry.referenceType ?? "manual"}
                      </div>
                    </div>
                    <Amount label="Gold" value={entry.amount} />
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: "ready" | "partial" | "missing" }) {
  const className =
    status === "ready"
      ? "border-emerald-500/30 text-emerald-600"
      : status === "partial"
        ? "border-amber-500/30 text-amber-600"
        : "border-border text-muted-foreground";
  return <span className={`border px-2 py-1 ${className}`}>Settlement {status}</span>;
}

function SettlementStatus({ status, riskLevel }: { status: string; riskLevel: "low" | "medium" | "high" }) {
  const statusClass =
    status === "approved"
      ? "border-emerald-500/30 text-emerald-600"
      : status === "rejected"
        ? "border-destructive/30 text-destructive"
        : status === "approval_required"
          ? "border-amber-500/30 text-amber-600"
          : "border-border text-muted-foreground";
  const riskClass =
    riskLevel === "high"
      ? "border-destructive/30 text-destructive"
      : riskLevel === "medium"
        ? "border-amber-500/30 text-amber-600"
        : "border-border text-muted-foreground";
  return (
    <>
      <span className={`border px-2 py-1 text-xs ${statusClass}`}>{status}</span>
      <span className={`border px-2 py-1 text-xs ${riskClass}`}>{riskLevel} risk</span>
    </>
  );
}

function MetricCard({ icon: Icon, label, value }: { icon: typeof DollarSign; label: string; value: string }) {
  return (
    <div className="border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-3 text-xl font-semibold">{value}</div>
    </div>
  );
}

function ThresholdInput({ label, value, onChange }: { label: string; value: string | undefined; onChange: (value: string) => void }) {
  return (
    <label className="grid gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        className="w-full border border-border bg-background px-2 py-2 text-sm"
        inputMode="numeric"
        min={1}
        type="number"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function Amount({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{formatGold(value)}</div>
    </div>
  );
}
