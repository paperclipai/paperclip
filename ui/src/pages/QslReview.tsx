import { useEffect, useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { qslApi, type QslIssue, type QslRule } from "../api/qsl";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, CheckCircle2, XCircle } from "lucide-react";

function deriveRuleId(issue: QslIssue): string | null {
  if (issue.rule_id) return issue.rule_id;
  if (issue.threat_category) {
    return issue.threat_category
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  }
  if (issue.title) {
    return issue.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 64);
  }
  return null;
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
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
        {rising ? "↑" : "↓"} {rising ? "+" : ""}
        {delta}%
      </span>{" "}
      <span className="text-muted-foreground font-normal">(was {prevPct}%)</span>
    </span>
  );
}

function ApprovalLabel({ approved }: { approved: boolean | null }) {
  if (approved === true) {
    return <span className="text-green-600">true</span>;
  }
  if (approved === false) {
    return <span className="text-red-500">false</span>;
  }
  return <span className="text-muted-foreground">null</span>;
}

type CardStatus = "idle" | "loading" | "approved" | "denied" | "error";

interface DeduplicatedIssue {
  issue: QslIssue;
  count: number;
}

function deduplicateIssues(issues: QslIssue[]): DeduplicatedIssue[] {
  const groups = new Map<string, DeduplicatedIssue>();
  for (const issue of issues) {
    const key = [issue.title, issue.threat_category ?? "", issue.severity ?? ""].join("\0");
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { issue, count: 1 });
    } else {
      existing.count++;
      if ((issue.risk_score ?? 0) > (existing.issue.risk_score ?? 0)) {
        existing.issue = issue;
      }
    }
  }
  return Array.from(groups.values());
}

interface QslIssueCardProps {
  issue: QslIssue;
  rule?: QslRule;
  count: number;
  onDecision: () => void;
}

function QslIssueCard({ issue, rule, count, onDecision }: QslIssueCardProps) {
  const [status, setStatus] = useState<CardStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const ruleId = deriveRuleId(issue);

  const mutation = useMutation({
    mutationFn: (approved: boolean) =>
      qslApi.approve({
        rule_id: ruleId!,
        approved,
        reason: approved ? "approved from Paperclip UI" : "denied from Paperclip UI",
        source: "paperclip-ui",
      }),
    onMutate: () => {
      setStatus("loading");
      setErrorMsg(null);
    },
    onSuccess: (_data, approved) => {
      setStatus(approved ? "approved" : "denied");
      onDecision();
    },
    onError: (err) => {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Request failed");
    },
  });

  const resolved = status === "approved" || status === "denied";

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="text-sm font-medium leading-snug">{issue.title}</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            {issue.severity && (
              <Badge variant="outline" className="text-[10px]">
                {issue.severity}
              </Badge>
            )}
            {issue.priority && (
              <Badge variant="outline" className="text-[10px]">
                {issue.priority}
              </Badge>
            )}
            {issue.risk_score != null && (
              <Badge variant="secondary" className="text-[10px]">
                risk {issue.risk_score}
              </Badge>
            )}
            {count > 1 && (
              <Badge variant="secondary" className="text-[10px]">
                Seen {count} times
              </Badge>
            )}
            {ruleId && (
              <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[200px]">
                {ruleId}
              </span>
            )}
          </div>
          {rule && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>
                Rule: <span className="font-mono">{rule.id}</span>
              </span>
              <span>
                Confidence:{" "}
                <ConfidenceDelta current={rule.confidence} previous={rule.previous_confidence} />
              </span>
              <span>
                Approved: <ApprovalLabel approved={rule.approved} />
              </span>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {resolved && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {status === "approved" ? (
                <><CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> Approved</>
              ) : (
                <><XCircle className="h-3.5 w-3.5 text-red-500" /> Denied</>
              )}
            </span>
          )}
          {!resolved && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={!ruleId || status === "loading"}
                onClick={() => mutation.mutate(false)}
              >
                Deny
              </Button>
              <Button
                size="sm"
                disabled={!ruleId || status === "loading"}
                onClick={() => mutation.mutate(true)}
              >
                Approve
              </Button>
            </>
          )}
        </div>
      </div>

      {!ruleId && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          No rule_id — cannot submit decision.
        </p>
      )}
      {status === "error" && (
        <p className="mt-2 text-xs text-destructive">{errorMsg}</p>
      )}
    </div>
  );
}

export function QslReview() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "QSL Review" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.qsl.issues,
    queryFn: qslApi.listIssues,
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

  const rawIssues = Array.isArray(data) ? data : [];
  const issues = useMemo(() => deduplicateIssues(rawIssues), [rawIssues]);

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
          {error instanceof Error ? error.message : "Failed to load QSL issues"}
        </p>
      </div>
    );
  }

  if (issues.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <ShieldAlert className="h-8 w-8 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">No QSL issues to review.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {issues.map(({ issue, count }, i) => {
        const ruleId = deriveRuleId(issue);
        const rule = ruleId ? ruleLookup.get(ruleId) : undefined;
        return (
          <QslIssueCard
            key={issue.id ?? i}
            issue={issue}
            rule={rule}
            count={count}
            onDecision={refetchAll}
          />
        );
      })}
    </div>
  );
}
