type Row = Record<string, any>;

/** Observation only. Activity counts successful route calls, not failed attempts. */
export function observeCheckoutActivity(input: {
  companyId: string; issueId: string; agentId: string;
  runs: Row[]; activity: Row[];
}) {
  const runIds = new Set(input.runs.map(run => run.id));
  const boundRuns = input.runs.length > 0 && runIds.size === input.runs.length &&
    input.runs.every(run => typeof run.id === "string" && Boolean(run.id) &&
      run.companyId === input.companyId && run.agentId === input.agentId &&
      run.contextSnapshot?.issueId === input.issueId);
  const rows = input.activity.filter(row => row.action === "issue.checked_out");
  const validRows = rows.every(row => typeof row.id === "string" && Boolean(row.id) &&
    row.companyId === input.companyId && row.entityType === "issue" &&
    row.entityId === input.issueId && row.actorType === "agent" &&
    row.agentId === input.agentId && runIds.has(row.runId));
  const uniqueRows = new Set(rows.map(row => row.id)).size === rows.length;
  const complete = boundRuns && validRows && uniqueRows;
  return {
    schema: "paperclip.checkout-activity.v1",
    status: complete ? "observed" : "uncomparable",
    companyId: input.companyId, issueId: input.issueId, agentId: input.agentId,
    scope: "successful checkout HTTP calls only; failed attempts require run-log inspection",
    successfulCheckoutRequests: complete ? rows.length : null,
    runs: input.runs.map(run => ({
      runId: run.id, status: run.status,
      checkedOutByHarness: run.contextSnapshot?.paperclipWake?.checkedOutByHarness === true,
      successfulCheckoutRequests: complete ? rows.filter(row => row.runId === run.id).length : null,
    })),
    receipts: rows.map(row => ({
      id: row.id, runId: row.runId, companyId: row.companyId,
      issueId: row.entityId, agentId: row.agentId, actorType: row.actorType,
    })),
  };
}
