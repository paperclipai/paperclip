import { describe, expect, it } from "vitest";
import { classifyRequestConfirmationReply } from "../services/awaiting-human-handoff.js";

describe("classifyRequestConfirmationReply", () => {
  it("matches Approve and Reject case-insensitively", () => {
    expect(classifyRequestConfirmationReply("Approve")).toBe("approve");
    expect(classifyRequestConfirmationReply("approve")).toBe("approve");
    expect(classifyRequestConfirmationReply("Reject")).toBe("reject");
    expect(classifyRequestConfirmationReply("reject")).toBe("reject");
  });

  it("treats Change replies as rejections", () => {
    expect(classifyRequestConfirmationReply("Change")).toBe("reject");
    expect(classifyRequestConfirmationReply("change")).toBe("reject");
    expect(classifyRequestConfirmationReply("Change please revise the timeline.")).toBe("reject");
  });

  it("returns null for unrelated replies", () => {
    expect(classifyRequestConfirmationReply("Please revise the plan first.")).toBeNull();
    expect(classifyRequestConfirmationReply("Start project")).toBeNull();
  });
});
