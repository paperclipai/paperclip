import { describe, expect, it } from "vitest";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "./approval.js";

describe("approval validators", () => {
  it("passes real line breaks through unchanged", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\n\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\n\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
  });

  it("accepts null and omitted optional decision notes", () => {
    expect(resolveApprovalSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(resolveApprovalSchema.parse({}).decisionNote).toBeUndefined();
    expect(requestApprovalRevisionSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(requestApprovalRevisionSchema.parse({}).decisionNote).toBeUndefined();
  });

  it("normalizes escaped line breaks in approval comments and decision notes", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\\n\\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\\n\\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
    expect(requestApprovalRevisionSchema.parse({ decisionNote: "Decision\\r\\nRevise." }).decisionNote)
      .toBe("Decision\nRevise.");
  });

  it("rejects unknown body keys via .strict() (ZERA-568 sweep)", () => {
    expect(() =>
      createApprovalSchema.parse({
        type: "general",
        payload: {},
        spoofedRequesterAgentId: "00000000-0000-0000-0000-000000000000",
      }),
    ).toThrow(/Unrecognized key/);
    expect(() => resolveApprovalSchema.parse({ extra: "no" })).toThrow(/Unrecognized key/);
    expect(() => requestApprovalRevisionSchema.parse({ extra: "no" })).toThrow(/Unrecognized key/);
    expect(() => resubmitApprovalSchema.parse({ extra: "no" })).toThrow(/Unrecognized key/);
    expect(() => addApprovalCommentSchema.parse({ body: "hi", extra: "no" })).toThrow(/Unrecognized key/);
  });
});
