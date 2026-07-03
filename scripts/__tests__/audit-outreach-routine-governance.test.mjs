import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diff } from "../audit-outreach-routine-governance.mjs";

const rrOutreachGovernanceConfig = {
  companyId: "0fabe377-3008-4cde-96ad-b1ae5eb5e469",
  operationsProjectId: "8e99b255-02f1-401d-ab06-93cc8dc15552",
  outreachProjectId: "202c77b2-e2d0-4030-a416-e41fcf246a3e",
  automateLabelId: "519fc58e-0411-4b5d-bdeb-02fb637e4f8f",
  outreachLabelId: "7f4ac6f1-6e9e-472d-a751-899b6a0c16d1",
  contentLabelId: "6c443851-fe4f-44e9-b11f-a4e2b9a4cbcd",
  ceoAgentId: "ce56f1d2-941d-42b1-a54b-fc99897d6e9e",
  outreachManagerAgentId: "c100bafe-c428-4e55-be99-0ec4ebaa32a0",
  outreachDirectReportAgentIds: ["e7651b93-a8ca-4c74-8ac0-2003678abb77"],
};

describe("audit-outreach-routine-governance", () => {
  it("flags routine issues with the wrong execution policy reviewer", () => {
    const finding = diff({
      id: "issue-1",
      identifier: "RR-TEST",
      companyId: rrOutreachGovernanceConfig.companyId,
      originKind: "routine_execution",
      title: "Daily outreach manager scan",
      description: "Find governance gaps.",
      assigneeAgentId: rrOutreachGovernanceConfig.outreachManagerAgentId,
      projectId: rrOutreachGovernanceConfig.outreachProjectId,
      labelIds: [rrOutreachGovernanceConfig.outreachLabelId],
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            type: "review",
            approvalsNeeded: 1,
            participants: [{ type: "agent", agentId: rrOutreachGovernanceConfig.outreachManagerAgentId }],
          },
        ],
      },
    }, rrOutreachGovernanceConfig);

    assert.ok(finding);
    assert.ok(finding.reasons.includes(`executionPolicy reviewer ${rrOutreachGovernanceConfig.outreachManagerAgentId} != ${rrOutreachGovernanceConfig.ceoAgentId}`));
    assert.equal(finding.patch.executionPolicy.stages[0].participants[0].agentId, rrOutreachGovernanceConfig.ceoAgentId);
  });
});
