import { describe, expect, it } from "vitest";
import {
  decisionEffectSchema,
  decisionInputsSchema,
  decisionOptionSchema,
  decisionOptionsSchema,
} from "./validators/decision.js";

const targetIssueId = "11111111-1111-4111-8111-111111111111";
const secondIssueId = "22222222-2222-4222-8222-222222222222";

describe("decision validators", () => {
  it("accepts all six effect variants", () => {
    const effects = [
      {
        type: "comment_on_issue",
        targetIssueId,
        staleness: "lenient",
        bodyMarkdown: "Approved with {{input.note}}",
      },
      {
        type: "create_issue",
        targetIssueId,
        staleness: "strict",
        draft: { title: "Follow up", parentId: targetIssueId },
      },
      {
        type: "update_issue_status",
        targetIssueId,
        staleness: "strict",
        status: "done",
        comment: "Decision approved",
      },
      {
        type: "assign_issue",
        targetIssueId,
        staleness: "lenient",
        assigneeAgentId: secondIssueId,
      },
      {
        type: "cancel_issue_tree",
        targetIssueId,
        staleness: "strict",
        reasonComment: "No longer needed",
      },
      {
        type: "resolve_blocker",
        targetIssueId,
        staleness: "strict",
        removeBlockedByIssueIds: [secondIssueId],
      },
    ];

    for (const effect of effects) {
      expect(decisionEffectSchema.parse(effect)).toEqual(effect);
    }
  });

  it("rejects malformed and unknown effects", () => {
    expect(() => decisionEffectSchema.parse({
      type: "comment_on_issue",
      targetIssueId,
      staleness: "strict",
    })).toThrow();
    expect(() => decisionEffectSchema.parse({
      type: "delete_company",
      targetIssueId,
      staleness: "strict",
    })).toThrow();
    expect(() => decisionEffectSchema.parse({
      type: "assign_issue",
      targetIssueId,
      staleness: "strict",
    })).toThrow();
  });

  it("forces cancel-tree effects to be strict and destructive", () => {
    expect(() => decisionEffectSchema.parse({
      type: "cancel_issue_tree",
      targetIssueId,
      staleness: "lenient",
      reasonComment: "No longer needed",
    })).toThrow();

    expect(() => decisionOptionSchema.parse({
      id: "cancel",
      label: "Cancel tree",
      effects: [{
        type: "cancel_issue_tree",
        targetIssueId,
        staleness: "strict",
        reasonComment: "No longer needed",
      }],
    })).toThrow();

    expect(decisionOptionSchema.parse({
      id: "cancel",
      label: "Cancel tree",
      style: "destructive",
      effects: [{
        type: "cancel_issue_tree",
        targetIssueId,
        staleness: "strict",
        reasonComment: "No longer needed",
      }],
    }).style).toBe("destructive");
  });

  it("enforces option, input, and effect limits", () => {
    const dismissOption = { id: "dismiss", label: "Dismiss", effects: [] };
    expect(decisionOptionsSchema.parse(Array.from({ length: 8 }, (_, index) => ({
      ...dismissOption,
      id: `option-${index}`,
    })))).toHaveLength(8);
    expect(() => decisionOptionsSchema.parse(Array.from({ length: 9 }, (_, index) => ({
      ...dismissOption,
      id: `option-${index}`,
    })))).toThrow();

    expect(decisionInputsSchema.parse(Array.from({ length: 4 }, (_, index) => ({
      id: `input-${index}`,
      label: `Input ${index}`,
    })))).toHaveLength(4);
    expect(() => decisionInputsSchema.parse(Array.from({ length: 5 }, (_, index) => ({
      id: `input-${index}`,
      label: `Input ${index}`,
    })))).toThrow();

    const commentEffect = {
      type: "comment_on_issue",
      targetIssueId,
      staleness: "strict",
      bodyMarkdown: "Comment",
    };
    expect(decisionOptionSchema.parse({
      id: "approve",
      label: "Approve",
      effects: Array.from({ length: 10 }, () => commentEffect),
    }).effects).toHaveLength(10);
    expect(() => decisionOptionSchema.parse({
      id: "approve",
      label: "Approve",
      effects: Array.from({ length: 11 }, () => commentEffect),
    })).toThrow();
  });

  it("rejects duplicate option and input ids", () => {
    expect(() => decisionOptionsSchema.parse([
      { id: "same", label: "One", effects: [] },
      { id: "same", label: "Two", effects: [] },
    ])).toThrow();
    expect(() => decisionInputsSchema.parse([
      { id: "same", label: "One" },
      { id: "same", label: "Two" },
    ])).toThrow();
  });
});
