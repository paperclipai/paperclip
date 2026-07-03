import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diff } from "../audit-outreach-routine-governance.mjs";
import {
  RR_CEO_AGENT_ID,
  RR_COMPANY_ID,
  RR_OUTREACH_GO_LIVE_PROJECT_ID,
  RR_OUTREACH_LABEL_ID,
  RR_OUTREACH_MANAGER_AGENT_ID,
} from "../../server/src/services/outreach-routine-governance.ts";

describe("audit-outreach-routine-governance", () => {
  it("flags routine issues with the wrong execution policy reviewer", () => {
    const finding = diff({
      id: "issue-1",
      identifier: "RR-TEST",
      companyId: RR_COMPANY_ID,
      originKind: "routine_execution",
      title: "Daily outreach manager scan",
      description: "Find governance gaps.",
      assigneeAgentId: RR_OUTREACH_MANAGER_AGENT_ID,
      projectId: RR_OUTREACH_GO_LIVE_PROJECT_ID,
      labelIds: [RR_OUTREACH_LABEL_ID],
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            type: "review",
            approvalsNeeded: 1,
            participants: [{ type: "agent", agentId: RR_OUTREACH_MANAGER_AGENT_ID }],
          },
        ],
      },
    });

    assert.ok(finding);
    assert.ok(finding.reasons.includes(`executionPolicy reviewer ${RR_OUTREACH_MANAGER_AGENT_ID} != ${RR_CEO_AGENT_ID}`));
    assert.equal(finding.patch.executionPolicy.stages[0].participants[0].agentId, RR_CEO_AGENT_ID);
  });
});
