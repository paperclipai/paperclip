import { describe, expect, it } from "vitest";
import {
  addApprovalCommentSchema,
  rejectApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
} from "./approval.js";

describe("approval validators", () => {
  describe("resolveApprovalSchema (approve)", () => {
    it("passes real line breaks through unchanged", () => {
      expect(resolveApprovalSchema.parse({ decisionNote: "Decision\n\nApproved." }).decisionNote)
        .toBe("Decision\n\nApproved.");
    });

    it("accepts null and omitted optional decision notes", () => {
      expect(resolveApprovalSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
      expect(resolveApprovalSchema.parse({}).decisionNote).toBeUndefined();
    });

    it("normalizes escaped line breaks", () => {
      expect(resolveApprovalSchema.parse({ decisionNote: "Decision\\n\\nApproved." }).decisionNote)
        .toBe("Decision\n\nApproved.");
    });
  });

  describe("rejectApprovalSchema (reject)", () => {
    it("accepts non-empty decisionNote", () => {
      expect(rejectApprovalSchema.parse({ decisionNote: "Rejected: budget too high" }).decisionNote)
        .toBe("Rejected: budget too high");
    });

    it("normalizes escaped line breaks", () => {
      expect(rejectApprovalSchema.parse({ decisionNote: "Not good\\nReject." }).decisionNote)
        .toBe("Not good\nReject.");
    });

    it("rejects missing decisionNote", () => {
      expect(() => rejectApprovalSchema.parse({})).toThrow();
    });

    it("rejects null decisionNote", () => {
      expect(() => rejectApprovalSchema.parse({ decisionNote: null })).toThrow();
    });

    it("rejects empty decisionNote", () => {
      expect(() => rejectApprovalSchema.parse({ decisionNote: "" })).toThrow();
    });
  });

  describe("requestApprovalRevisionSchema (request-revision)", () => {
    it("accepts non-empty decisionNote", () => {
      expect(
        requestApprovalRevisionSchema.parse({ decisionNote: "Needs: fix the budget" }).decisionNote,
      ).toBe("Needs: fix the budget");
    });

    it("normalizes escaped line breaks", () => {
      expect(
        requestApprovalRevisionSchema.parse({ decisionNote: "Fix\\r\\nRevise." }).decisionNote,
      ).toBe("Fix\nRevise.");
    });

    it("rejects missing decisionNote", () => {
      expect(() => requestApprovalRevisionSchema.parse({})).toThrow();
    });

    it("rejects null decisionNote", () => {
      expect(() => requestApprovalRevisionSchema.parse({ decisionNote: null })).toThrow();
    });

    it("rejects empty decisionNote", () => {
      expect(() => requestApprovalRevisionSchema.parse({ decisionNote: "" })).toThrow();
    });
  });

  describe("addApprovalCommentSchema", () => {
    it("passes real line breaks through unchanged", () => {
      expect(addApprovalCommentSchema.parse({ body: "Looks good\n\nApproved." }).body)
        .toBe("Looks good\n\nApproved.");
    });

    it("normalizes escaped line breaks", () => {
      expect(addApprovalCommentSchema.parse({ body: "Looks good\\n\\nApproved." }).body)
        .toBe("Looks good\n\nApproved.");
    });
  });
});
