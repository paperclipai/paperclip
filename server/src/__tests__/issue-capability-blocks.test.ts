import { describe, expect, it } from "vitest";
import {
  classifyCapabilityBlockedIssue,
  resolveOutstandingSpecialistCapabilityBlock,
  resolveSpecialistLaneRequirement,
} from "../services/issue-capability-blocks.ts";

describe("issue capability blocks", () => {
  it("describes security workflow lanes as specialist-gated work", () => {
    expect(resolveSpecialistLaneRequirement({
      workflowLaneRole: "security",
    })).toMatchObject({
      blockingRole: "security",
      headline: "No security specialist available",
      detail: "security workflow lane requires a security specialist, but none are currently available",
    });
  });

  it("marks open unassigned security lanes as capability-blocked when no specialist exists", () => {
    expect(classifyCapabilityBlockedIssue({
      issue: {
        status: "todo",
        workflowLaneRole: "security",
        assigneeAgentId: null,
        assigneeUserId: null,
      },
      eligibleSpecialistRoleIds: {
        security: [],
      },
    })).toMatchObject({
      blockingRole: "security",
      headline: "No security specialist available",
    });
  });

  it("marks open unassigned QA lanes as capability-blocked when no QA reviewer exists", () => {
    expect(resolveSpecialistLaneRequirement({
      workflowLaneRole: "qa",
    })).toMatchObject({
      blockingRole: "qa",
      headline: "No healthy QA reviewer available",
    });

    expect(classifyCapabilityBlockedIssue({
      issue: {
        status: "todo",
        workflowLaneRole: "qa",
        assigneeAgentId: null,
        assigneeUserId: null,
      },
      eligibleSpecialistRoleIds: {
        security: ["agent-security"],
        qa: [],
      },
    })).toMatchObject({
      blockingRole: "qa",
      headline: "No healthy QA reviewer available",
    });
  });

  it("marks open unassigned QA-like work as capability-blocked when no QA reviewer exists", () => {
    expect(classifyCapabilityBlockedIssue({
      issue: {
        status: "todo",
        workflowLaneRole: null,
        identifier: "COMA-2005",
        title: "QA: Validate checkout release",
        description: null,
        assigneeAgentId: null,
        assigneeUserId: null,
      },
      eligibleSpecialistRoleIds: {
        security: ["agent-security"],
        qa: [],
      },
    })).toMatchObject({
      blockingRole: "qa",
      headline: "No healthy QA reviewer available",
    });
  });

  it("marks open unassigned CTO lanes as capability-blocked when no CTO exists", () => {
    expect(resolveSpecialistLaneRequirement({
      workflowLaneRole: "cto",
    })).toMatchObject({
      blockingRole: "cto",
      headline: "No CTO available",
    });

    expect(classifyCapabilityBlockedIssue({
      issue: {
        status: "todo",
        workflowLaneRole: "cto",
        assigneeAgentId: null,
        assigneeUserId: null,
      },
      eligibleSpecialistRoleIds: {
        security: ["agent-security"],
        qa: ["agent-qa"],
        cto: [],
      },
    })).toMatchObject({
      blockingRole: "cto",
      headline: "No CTO available",
    });
  });

  it("does not capability-block specialist lanes while a real blocker is still active", () => {
    expect(resolveOutstandingSpecialistCapabilityBlock({
      workflowLaneRole: "security",
      hasActiveBlockers: true,
      eligibleSpecialistRoleIds: {
        security: [],
      },
    })).toBeNull();

    expect(classifyCapabilityBlockedIssue({
      issue: {
        status: "blocked",
        workflowLaneRole: "security",
        assigneeAgentId: null,
        assigneeUserId: null,
        hasActiveBlockers: true,
      },
      eligibleSpecialistRoleIds: {
        security: [],
      },
    })).toBeNull();
  });

  it("does not capability-block staffed or staffable lanes", () => {
    expect(classifyCapabilityBlockedIssue({
      issue: {
        status: "todo",
        workflowLaneRole: "security",
        assigneeAgentId: "agent-security",
        assigneeUserId: null,
      },
      eligibleSpecialistRoleIds: {
        security: [],
      },
    })).toBeNull();

    expect(classifyCapabilityBlockedIssue({
      issue: {
        status: "todo",
        workflowLaneRole: "security",
        assigneeAgentId: null,
        assigneeUserId: null,
      },
      eligibleSpecialistRoleIds: {
        security: ["agent-security"],
      },
    })).toBeNull();
  });

  it("ignores terminal issues and non-specialist lanes", () => {
    expect(classifyCapabilityBlockedIssue({
      issue: {
        status: "done",
        workflowLaneRole: "security",
        assigneeAgentId: null,
        assigneeUserId: null,
      },
      eligibleSpecialistRoleIds: {
        security: [],
      },
    })).toBeNull();

    expect(classifyCapabilityBlockedIssue({
      issue: {
        status: "todo",
        workflowLaneRole: "engineer",
        assigneeAgentId: null,
        assigneeUserId: null,
      },
      eligibleSpecialistRoleIds: {
        security: [],
      },
    })).toBeNull();
  });
});
