import type { IssueWorkflow } from "../../api/issues";

export function createDeterministicIssueWorkflow(): IssueWorkflow {
  return {
    issue: {
      id: "issue-work-2371",
      companyId: "company-working",
      status: "todo",
      assigneeAgentId: null,
      executionRunId: null,
    },
    summary: {
      totalRuns: 2,
      activeRuns: 0,
      latestRunStatus: "failed",
      latestEventSeq: 1,
    },
    nodes: [
      { id: "issue:issue-work-2371", type: "issue", status: "todo", label: "WORK-2371" },
      { id: "run:run-a", type: "run", status: "failed", label: "Working QA Engineer" },
      { id: "run:run-b", type: "run", status: "failed", label: "Working QA Engineer" },
      { id: "event:run-a:1", type: "event", status: "error", label: "error #1" },
      { id: "event:run-a:3", type: "event", status: "error", label: "error #3" },
      { id: "event:run-a:2", type: "event", status: "lifecycle", label: "lifecycle #2" },
      { id: "event:run-b:1", type: "event", status: "lifecycle", label: "lifecycle #1" },
      { id: "event:run-b:2", type: "event", status: "lifecycle", label: "lifecycle #2" },
      { id: "event:run-b:3", type: "event", status: "stdout", label: "stdout #3" },
    ],
    edges: [
      { id: "issue:issue-work-2371->run:run-a", source: "issue:issue-work-2371", target: "run:run-a" },
      { id: "issue:issue-work-2371->run:run-b", source: "issue:issue-work-2371", target: "run:run-b" },
      { id: "run:run-a->event:run-a:1", source: "run:run-a", target: "event:run-a:1" },
      { id: "run:run-a->event:run-a:3", source: "run:run-a", target: "event:run-a:3" },
      { id: "run:run-a->event:run-a:2", source: "run:run-a", target: "event:run-a:2" },
      { id: "run:run-b->event:run-b:1", source: "run:run-b", target: "event:run-b:1" },
      { id: "run:run-b->event:run-b:2", source: "run:run-b", target: "event:run-b:2" },
      { id: "run:run-b->event:run-b:3", source: "run:run-b", target: "event:run-b:3" },
    ],
  };
}
