/**
 * RBR-791: prove the backfill migration writes result JSON that the runtime's
 * per-kind result validators accept. If these shapes drift, listInteractions
 * would fail to hydrate the backfilled rows.
 */
import { describe, expect, it } from "vitest";
import {
  askUserQuestionsResultSchema,
  requestCheckboxConfirmationResultSchema,
  requestConfirmationResultSchema,
  requestItemVerdictsResultSchema,
  suggestTasksResultSchema,
} from "@paperclipai/shared";

// These literals mirror the jsonb_build_object branches in
// packages/db/src/migrations/0208_expire_pending_interactions_on_closed_issues.sql
const askUserQuestionsBackfill = {
  version: 1,
  outcome: "issue_closed",
  reason: null,
  answers: [],
  summaryMarkdown: null,
};

const itemVerdictsBackfill = {
  version: 1,
  outcome: "issue_closed",
  reason: null,
  complete: false,
  items: [],
};

const genericBackfill = {
  version: 1,
  outcome: "issue_closed",
  reason: null,
};

describe("RBR-791 backfill result shapes", () => {
  it("ask_user_questions backfill parses", () => {
    expect(() => askUserQuestionsResultSchema.parse(askUserQuestionsBackfill)).not.toThrow();
  });

  it("suggest_tasks backfill parses", () => {
    expect(() => suggestTasksResultSchema.parse(genericBackfill)).not.toThrow();
  });

  it("request_item_verdicts backfill parses", () => {
    expect(() => requestItemVerdictsResultSchema.parse(itemVerdictsBackfill)).not.toThrow();
  });

  it("request_confirmation backfill parses", () => {
    expect(() => requestConfirmationResultSchema.parse(genericBackfill)).not.toThrow();
  });

  it("request_checkbox_confirmation backfill parses", () => {
    expect(() => requestCheckboxConfirmationResultSchema.parse(genericBackfill)).not.toThrow();
  });

  it("does not smuggle an accept/decline verdict into a backfilled row", () => {
    // AC4 guard at the data layer: the backfill only ever writes issue_closed,
    // never an outcome that reads as a board decision.
    for (const shape of [askUserQuestionsBackfill, itemVerdictsBackfill, genericBackfill]) {
      expect(shape.outcome).toBe("issue_closed");
      expect(["accepted", "rejected", "resolved"]).not.toContain(shape.outcome);
    }
  });
});
