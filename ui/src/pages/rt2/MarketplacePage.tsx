import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes, CheckCircle2, Coins, Database, Star, Users } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageSkeleton } from "../../components/PageSkeleton";
import { rt2EconomyApi } from "../../api/rt2-economy";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";

export function MarketplacePage() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Jarvis 마켓" }]);
  }, [setBreadcrumbs]);

  const listings = useQuery({
    queryKey: ["rt2-marketplace-listings", selectedCompanyId],
    queryFn: () => rt2EconomyApi.listMarketplaceAgents(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  if (!selectedCompany) {
    return <EmptyState icon={Boxes} message="Jarvis 마켓을 열 회사를 먼저 선택하세요." />;
  }

  if (listings.isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (listings.error) {
    return <p className="text-sm text-destructive">{(listings.error as Error).message}</p>;
  }

  const items = listings.data ?? [];

  return (
    <div className="space-y-6">
      <section className="border border-border bg-card px-6 py-5">
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase text-muted-foreground">Jarvis Market</div>
          <h1 className="text-2xl font-semibold tracking-tight">{selectedCompany.name} Jarvis 마켓</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Jarvis agent, skill, 가격, 산출물 성과, 평판을 RealTycoon2 기록에서 함께 보여줍니다.
          </p>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {items.length === 0 ? (
          <div className="border border-border bg-card px-5 py-6 text-sm text-muted-foreground">
            현재 회사에서 공개한 Jarvis listing이 없습니다.
          </div>
        ) : (
          items.map((listing) => {
            const evidence = listing.evidence;
            return (
              <article key={listing.id} className="border border-border bg-card p-5">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold">{listing.name}</h2>
                      <span className="border border-border px-2 py-1 text-xs text-muted-foreground">
                        {listing.category}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground">{listing.description ?? "설명이 없습니다."}</p>
                  </div>
                  <div className="text-right text-sm">
                    <div className="font-medium">{formatPrice(listing.pricePerTaskCents, listing.monthlySubscriptionCents)}</div>
                    <div className="text-xs text-muted-foreground">{listing.pricingType}</div>
                  </div>
                </div>

                <div className="mt-5 grid gap-3 md:grid-cols-3">
                  <EvidenceMetric icon={CheckCircle2} label="Approved" value={`${evidence?.approvedDeliverableCount ?? 0}`} />
                  <EvidenceMetric icon={Star} label="Quality" value={evidence?.averageQualityScore?.toString() ?? "-"} />
                  <EvidenceMetric icon={Coins} label="Gold basis" value={`${evidence?.approvedBasePriceGold ?? 0} G`} />
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_14rem]">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                      <Database className="h-4 w-4" />
                      Calculation evidence
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <StatusBadge status={evidence?.evidenceStatus ?? "missing"} />
                      <span className="border border-border px-2 py-1 text-muted-foreground">
                        Earned estimate {evidence?.earnedGoldEstimate ?? 0} G
                      </span>
                      <span className="border border-border px-2 py-1 text-muted-foreground">
                        Reputation {evidence?.reputationIndex ?? "-"}
                      </span>
                      <span className="border border-border px-2 py-1 text-muted-foreground">
                        Collaboration x{evidence?.collaborationMultiplier ?? "-"}
                      </span>
                      <span className="border border-border px-2 py-1 text-muted-foreground">
                        Subscriptions {evidence?.subscriptionCount ?? 0}
                      </span>
                    </div>
                    {(evidence?.latestApprovedDeliverables ?? []).length > 0 ? (
                      <div className="divide-y divide-border border border-border">
                        {evidence!.latestApprovedDeliverables.map((deliverable) => (
                          <div key={deliverable.workProductId} className="grid gap-2 px-3 py-2 text-xs md:grid-cols-[minmax(0,1fr)_5rem_5rem]">
                            <div className="min-w-0">
                              <div className="truncate font-medium">{deliverable.title}</div>
                              <div className="text-muted-foreground">{deliverable.type}</div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Base</span> {deliverable.basePriceGold} G
                            </div>
                            <div>
                              <span className="text-muted-foreground">Q</span> {deliverable.qualityScore}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Approved deliverable evidence가 아직 없습니다.</p>
                    )}
                  </div>
                  <EvidenceMetric icon={Users} label="Demand" value={`${evidence?.subscriptionCount ?? listing.totalSubscriptions}`} />
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {(evidence?.skills ?? listing.tags ?? []).slice(0, 6).map((skill) => (
                    <span key={skill} className="bg-muted px-2 py-1 text-xs text-muted-foreground">
                      {skill}
                    </span>
                  ))}
                </div>
              </article>
            );
          })
        )}
      </section>
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
  return <span className={`border px-2 py-1 ${className}`}>Evidence {status}</span>;
}

function EvidenceMetric({ icon: Icon, label, value }: { icon: typeof CheckCircle2; label: string; value: string }) {
  return (
    <div className="border border-border bg-background p-3">
      <div className="flex items-center gap-2 text-xs uppercase text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-2 text-lg font-semibold">{value}</div>
    </div>
  );
}

function formatPrice(pricePerTaskCents: number | null, monthlySubscriptionCents: number | null) {
  if (pricePerTaskCents !== null) return `$${(pricePerTaskCents / 100).toLocaleString()} / task`;
  if (monthlySubscriptionCents !== null) return `$${(monthlySubscriptionCents / 100).toLocaleString()} / month`;
  return "No price";
}
