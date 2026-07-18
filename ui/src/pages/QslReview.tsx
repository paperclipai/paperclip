import { useEffect, useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { qslApi, type QslFinding, type QslRule } from "../api/qsl";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, CheckCircle2, XCircle, Clock, Eye, ArrowUpRight } from "lucide-react";

type ReviewFilter = "all" | "active" | "new" | "recurring" | "pending_review" | "approved" | "denied" | "suppressed" | "accepted_risk" | "escalated";

const FILTER_OPTIONS: { value: ReviewFilter; label: string }[] = [
  { value: "active", label: "Active Queue" },
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "recurring", label: "Recurring" },
  { value: "pending_review", label: "Pending Review" },
  { value: "approved", label: "Approved" },
  { value: "denied", label: "Denied" },
  { value: "suppressed", label: "Suppressed" },
  { value: "accepted_risk", label: "Accepted Risk" },
  { value: "escalated", label: "Escalated" },
];

function reviewStateBadge(state: string) {
  switch (state) {
    case "new":
      return <Badge variant="destructive" className="text-(length:--text-nano)">New</Badge>;
    case "recurring":
      return <Badge className="text-(length:--text-nano) bg-amber-500 hover:bg-amber-600">Recurring</Badge>;
    case "pending_review":
      return <Badge className="text-(length:--text-nano) bg-blue-500 hover:bg-blue-600">Pending Review</Badge>;
    case "approved":
      return <Badge variant="outline" className="text-(length:--text-nano) border-green-500 text-green-600">Approved</Badge>;
    case "denied":
      return <Badge variant="outline" className="text-(length:--text-nano) border-red-500 text-red-600">Denied</Badge>;
    case "suppressed":
      return <Badge variant="secondary" className="text-(length:--text-nano)">Suppressed</Badge>;
    case "accepted_risk":
      return <Badge variant="outline" className="text-(length:--text-nano) border-amber-500 text-amber-600">Accepted Risk</Badge>;
    case "escalated":
      return <Badge variant="destructive" className="text-(length:--text-nano)">Escalated</Badge>;
    default:
      return <Badge variant="outline" className="text-(length:--text-nano)">{state}</Badge>;
  }
}

function decisionIcon(decision: string | null) {
  if (decision === "approved") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
  }
  if (decision === "denied") {
    return <XCircle className="h-3.5 w-3.5 text-red-500" />;
  }
  return null;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ConfidenceDelta({ current, previous }: { current: number; previous?: number }) {
  const pct = Math.round(current * 100);
  if (previous == null || previous === current) {
    return <span className="font-medium text-foreground">{pct}%</span>;
  }
  const prevPct = Math.round(previous * 100);
  const delta = pct - prevPct;
  const rising = delta > 0;
  return (
    <span className="font-medium text-foreground">
      {pct}%{" "}
      <span className={rising ? "text-green-600" : "text-red-500"}>
        {rising ? "\u2191" : "\u2193"} {rising ? "+" : ""}
        {delta}%
      </span>{" "}
      <span className="text-muted-foreground font-normal">(was {prevPct}%)</span>
    </span>
  );
}

type CardStatus = "idle" | "loading" | "done" | "error";

interface FindingCardProps {
  finding: QslFinding;
  rule?: QslRule;
  companyId: string;
  onDecision: () => void;
}

function FindingCard({ finding, rule, companyId, onDecision }: FindingCardProps) {
  const [status, setStatus] = useState<CardStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isReviewed = finding.reviewDecision !== null;

  const reviewMutation = useMutation({
    mutationFn: (decision: "approved" | "denied") =>
      qslApi.reviewFinding(companyId, finding.id, { decision }),
    onMutate: () => {
      setStatus("loading");
      setErrorMsg(null);
    },
    onSuccess: () => {
      setStatus("done");
      onDecision();
    },
    onError: (err) => {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Request failed");
    },
  });

  const stateMutation = useMutation({
    mutationFn: (state: string) =>
      qslApi.setFindingState(companyId, finding.id, { state }),
    onMutate: () => {
      setStatus("loading");
    },
    onSuccess: () => {
      setStatus("done");
      onDecision();
    },
    onError: (err) => {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Request failed");
    },
  });

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="text-sm font-medium leading-snug">{finding.title}</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            {reviewStateBadge(finding.reviewState)}
            {finding.severity && (
              <Badge variant="outline" className="text-(length:--text-nano)">
                {finding.severity}
              </Badge>
            )}
            {finding.latestRiskScore != null && (
              <Badge variant="secondary" className="text-(length:--text-nano)">
                risk {finding.latestRiskScore}
              </Badge>
            )}
            {finding.occurrenceCount > 1 && (
              <Badge variant="secondary" className="text-(length:--text-nano)">
                {finding.occurrenceCount}x seen
              </Badge>
            )}
            {finding.ruleId && (
              <span className="text-(length:--text-nano) text-muted-foreground font-mono truncate max-w-52">
                {finding.ruleId}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-(length:--text-micro) text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              First: {formatRelativeTime(finding.firstSeen)}
            </span>
            <span className="flex items-center gap-1">
              <Eye className="h-3 w-3" />
              Last: {formatRelativeTime(finding.lastSeen)}
            </span>
            {finding.reviewedAt && (
              <span className="flex items-center gap-1">
                {decisionIcon(finding.reviewDecision)}
                Reviewed: {formatRelativeTime(finding.reviewedAt)}
                {finding.reviewerId && ` by ${finding.reviewerId}`}
              </span>
            )}
          </div>

          {rule && (
            <div className="flex flex-wrap items-center gap-2 text-(length:--text-micro) text-muted-foreground">
              <span>
                Confidence:{" "}
                <ConfidenceDelta current={rule.confidence} previous={rule.previous_confidence} />
              </span>
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {isReviewed && status !== "loading" ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {finding.reviewDecision === "approved" ? (
                <><CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> Approved</>
              ) : (
                <><XCircle className="h-3.5 w-3.5 text-red-500" /> Denied</>
              )}
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={status === "loading"}
                onClick={() => reviewMutation.mutate("denied")}
              >
                Deny
              </Button>
              <Button
                size="sm"
                disabled={status === "loading"}
                onClick={() => reviewMutation.mutate("approved")}
              >
                Approve
              </Button>
            </div>
          )}

          {/* State actions */}
          <div className="flex items-center gap-1">
            {!["approved", "denied", "suppressed", "escalated"].includes(finding.reviewState) && finding.reviewState !== "accepted_risk" && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-(length:--text-nano)"
                disabled={status === "loading"}
                onClick={() => stateMutation.mutate("accepted_risk")}
              >
                Accept Risk
              </Button>
            )}
            {!["suppressed"].includes(finding.reviewState) && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-(length:--text-nano)"
                disabled={status === "loading"}
                onClick={() => stateMutation.mutate("suppressed")}
              >
                Suppress
              </Button>
            )}
            {!["escalated"].includes(finding.reviewState) && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-(length:--text-nano) text-destructive"
                disabled={status === "loading"}
                onClick={() => stateMutation.mutate("escalated")}
              >
                <ArrowUpRight className="h-3 w-3 mr-0.5" />
                Escalate
              </Button>
            )}
          </div>
        </div>
      </div>

      {status === "error" && (
        <p className="mt-2 text-xs text-destructive">{errorMsg}</p>
      )}
    </div>
  );
}

export function QslReview() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<ReviewFilter>("active");

  useEffect(() => {
    setBreadcrumbs([{ label: "QSL Review" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? "";

  const { data: findings, isLoading, error } = useQuery({
    queryKey: [...queryKeys.qsl.issues, "findings", companyId, filter],
    queryFn: () => qslApi.listFindings(companyId, filter === "all" ? undefined : filter),
    enabled: !!companyId,
  });

  const { data: stateData } = useQuery({
    queryKey: queryKeys.qsl.state,
    queryFn: qslApi.getState,
  });

  const ruleLookup = useMemo(() => {
    const map = new Map<string, QslRule>();
    if (stateData?.rules) {
      for (const rule of stateData.rules) {
        map.set(rule.id, rule);
      }
    }
    return map;
  }, [stateData]);

  const refetchAll = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.qsl.issues });
    queryClient.invalidateQueries({ queryKey: queryKeys.qsl.state });
  };

  const findingsList = Array.isArray(findings) ? findings : [];

  // Compute counts for filter badges
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of findingsList) {
      c[f.reviewState] = (c[f.reviewState] ?? 0) + 1;
    }
    c.all = findingsList.length;
    return c;
  }, [findingsList]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center">
        <ShieldAlert className="mx-auto h-8 w-8 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load QSL findings"}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap gap-1.5">
        {FILTER_OPTIONS.map((opt) => (
          <Button
            key={opt.value}
            size="sm"
            variant={filter === opt.value ? "default" : "outline"}
            className="h-7 text-xs"
            onClick={() => setFilter(opt.value)}
          >
            {opt.label}
            {(filter === "all" || filter === "active") && !["all", "active"].includes(opt.value) && counts[opt.value] ? (
              <span className="ml-1 text-(length:--text-nano) opacity-70">({counts[opt.value]})</span>
            ) : null}
          </Button>
        ))}
      </div>

      {findingsList.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ShieldAlert className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {filter === "active" ? "No active findings in the review queue." : filter === "all" ? "No QSL findings." : `No ${filter.replace("_", " ")} findings.`}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {findingsList.map((finding) => {
            const rule = finding.ruleId ? ruleLookup.get(finding.ruleId) : undefined;
            return (
              <FindingCard
                key={finding.id}
                finding={finding}
                rule={rule}
                companyId={companyId}
                onDecision={refetchAll}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
