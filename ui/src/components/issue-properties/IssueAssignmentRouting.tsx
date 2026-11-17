import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ASSIGNMENT_SCORE_KEYS,
  ASSIGNMENT_STRATEGIES,
  type AssignmentCandidate,
  type AssignmentStrategy,
  type Issue,
  type IssueAssignmentRouting,
} from "@paperclipai/shared";
import { issuesApi } from "../../api/issues";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import {
  ASSIGNMENT_SCORE_LABELS,
  ASSIGNMENT_STRATEGY_LABELS,
  assignmentCandidateName,
  formatAssignmentScore,
  formatIssueAssignmentRouting,
  parseCapabilityTags,
} from "../../lib/agent-assignment";
import { PropertyPicker } from "./property-picker";

const MAX_REQUIRED_CAPABILITIES = 16;

function CandidateRow({ candidate, selected }: { candidate: AssignmentCandidate; selected: boolean }) {
  return (
    <li className="rounded border border-border px-2 py-1.5" data-testid="assignment-candidate">
      <div className="flex items-center gap-2 text-sm">
        <span className="flex-1 truncate font-medium">{candidate.name}</span>
        {selected ? <span className="text-xs text-muted-foreground">Chosen</span> : null}
        {candidate.eligible && candidate.rank !== null ? (
          <span className="text-xs text-muted-foreground">
            #{candidate.rank}{candidate.total !== null ? ` · ${candidate.total.toFixed(2)}` : ""}
          </span>
        ) : null}
      </div>
      {!candidate.eligible ? (
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {(candidate.excludedReasons.length > 0 ? candidate.excludedReasons : ["Not eligible"]).map((reason) => (
            <li key={reason}>Excluded: {reason}</li>
          ))}
        </ul>
      ) : null}
      {candidate.scores ? (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs text-muted-foreground">
          {ASSIGNMENT_SCORE_KEYS.map((key) => {
            const score = candidate.scores![key];
            return (
              <div key={key} className="contents">
                <dt>{ASSIGNMENT_SCORE_LABELS[key]}</dt>
                <dd className="truncate" title={score.detail ?? undefined}>
                  {formatAssignmentScore(score)}{score.detail ? ` · ${score.detail}` : ""}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
    </li>
  );
}

function RoutingDetails({ routing }: { routing: IssueAssignmentRouting }) {
  const chosen = assignmentCandidateName(routing, routing.selectedAgentId);
  const fallbackFrom = routing.fallback ? assignmentCandidateName(routing, routing.fallback.fromAgentId) ?? "another agent" : null;
  return (
    <div className="space-y-1.5 px-2 py-1.5 text-xs" data-testid="assignment-routing-details">
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        <dt className="text-muted-foreground">Status</dt>
        <dd>{routing.status === "assigned" ? "Assigned" : "No agent matched"}</dd>
        <dt className="text-muted-foreground">Strategy</dt>
        <dd>{ASSIGNMENT_STRATEGY_LABELS[routing.strategy]}</dd>
        {chosen ? (<><dt className="text-muted-foreground">Chosen</dt><dd>{chosen}</dd></>) : null}
        {routing.requiredCapabilities.length > 0 ? (
          <><dt className="text-muted-foreground">Needs</dt><dd>{routing.requiredCapabilities.join(", ")}</dd></>
        ) : null}
      </dl>
      {routing.fallback ? (
        <p className="rounded border border-border bg-muted/40 px-2 py-1">
          Moved from {fallbackFrom}: {routing.fallback.reason}
        </p>
      ) : null}
      {routing.candidates.length > 0 ? (
        <ul className="space-y-1">
          {routing.candidates.map((candidate) => (
            <CandidateRow key={candidate.agentId} candidate={candidate} selected={candidate.agentId === routing.selectedAgentId} />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">No agents to compare.</p>
      )}
    </div>
  );
}

export function IssueAssignmentRoutingRow({
  issueId,
  companyId,
  routing,
  canAutoAssign,
  inline,
}: {
  issueId: string;
  companyId?: string | null;
  routing: IssueAssignmentRouting | null;
  canAutoAssign: boolean;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [strategy, setStrategy] = useState<AssignmentStrategy>("balanced");
  const [capabilities, setCapabilities] = useState("");
  const queryClient = useQueryClient();
  const autoAssign = useMutation({
    mutationFn: () => issuesApi.autoAssign(issueId, {
      strategy,
      requiredCapabilities: parseCapabilityTags(capabilities, MAX_REQUIRED_CAPABILITIES),
    }),
    onSuccess: ({ assignmentRouting }) => {
      queryClient.setQueryData<Issue>(queryKeys.issues.detail(issueId), (current) =>
        current ? { ...current, assignmentRouting } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      if (companyId) void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });
  const summary = formatIssueAssignmentRouting(routing);

  return (
    <PropertyPicker
      inline={inline}
      label="Assignment"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) autoAssign.reset();
      }}
      triggerContent={<span className={cn("truncate text-sm", !routing && "text-muted-foreground")} title={summary}>{summary}</span>}
      triggerClassName="min-w-0 max-w-full"
      popoverClassName="w-80"
    >
      <div className="max-h-(--sz-24rem) overflow-y-auto">
        {routing ? <RoutingDetails routing={routing} /> : null}
        {canAutoAssign ? (
          <form
            className={cn("space-y-1.5 px-2 py-1.5", routing && "border-t border-border")}
            onSubmit={(event) => {
              event.preventDefault();
              autoAssign.mutate();
            }}
          >
            <NativeSelect
              aria-label="Strategy"
              value={strategy}
              onChange={(event) => setStrategy(event.target.value as AssignmentStrategy)}
            >
              {ASSIGNMENT_STRATEGIES.map((option) => (
                <option key={option} value={option}>{ASSIGNMENT_STRATEGY_LABELS[option]}</option>
              ))}
            </NativeSelect>
            <input
              aria-label="Required capabilities"
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground/60"
              placeholder="Required capabilities (optional)"
              value={capabilities}
              onChange={(event) => setCapabilities(event.target.value)}
            />
            <Button type="submit" size="xs" className="w-full" disabled={autoAssign.isPending}>
              {autoAssign.isPending ? "Assigning…" : "Auto-assign"}
            </Button>
            <p className="text-xs text-muted-foreground">Picks from agents with automatic assignment on. You can still choose an assignee by hand.</p>
          </form>
        ) : null}
        {autoAssign.error ? (
          <div role="alert" className="mx-2 mb-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {autoAssign.error instanceof Error ? autoAssign.error.message : "Could not assign the task."}
          </div>
        ) : null}
      </div>
    </PropertyPicker>
  );
}
