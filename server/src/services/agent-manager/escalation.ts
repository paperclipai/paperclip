type ScoreHistoryRow = {
  runId: string;
  score: number | null;
  outcome: string;
};

export function buildIncidentCommentBody(input: {
  issueIdentifier: string;
  companyPrefix: string;
  agentUrlKey: string;
  sourceRunId: string;
  score: number;
  attempt: number;
  maxAttempts: number;
  rationale: string;
  scoreHistory: ScoreHistoryRow[];
}): string {
  const historyRows = input.scoreHistory
    .map((row) => `| ${row.runId.slice(0, 8)} | ${row.score ?? "n/a"} | ${row.outcome} |`)
    .join("\n");

  return `## Agent Manager incident report

**Issue:** [${input.issueIdentifier}](/${input.companyPrefix}/issues/${input.issueIdentifier})
**Source run:** [run-${input.sourceRunId.slice(0, 8)}](/${input.companyPrefix}/agents/${input.agentUrlKey}/runs/${input.sourceRunId})
**Final score:** ${input.score}/100
**Reflection attempts:** ${input.attempt}/${input.maxAttempts}

### Failure summary
${input.rationale}

### Score history
| Run | Score | Outcome |
|-----|-------|---------|
${historyRows || "| — | — | — |"}

### Recommended board actions
- [ ] Review agent output and confirm whether task should be reassigned
- [ ] Reset supervision counter if false positive
- [ ] Adjust acceptance criteria if spec was ambiguous

### Unblock
Chief of Staff or board must set issue status away from \`blocked\` after decision.`;
}

export function buildEscalationWakeContext(input: {
  evaluationId: string;
  sourceRunId: string;
  sourceAgentId: string;
  issueId: string;
  finalScore: number;
  reflectionAttempts: number;
}) {
  return {
    issueId: input.issueId,
    wakeReason: "agent_manager_escalation",
    agentManagerEscalation: {
      evaluationId: input.evaluationId,
      sourceRunId: input.sourceRunId,
      sourceAgentId: input.sourceAgentId,
      finalScore: input.finalScore,
      reflectionAttempts: input.reflectionAttempts,
    },
  };
}

export function buildIncidentCommentMetadata(input: {
  evaluationId: string;
  score: number;
  sourceRunId: string;
}) {
  return {
    rowType: "agent_manager_incident",
    evaluationId: input.evaluationId,
    score: input.score,
    sourceRunId: input.sourceRunId,
  };
}
