import { describe, expect, it } from "vitest";
import { classifyRequestConfirmationReply } from "../services/awaiting-human-handoff.js";

const payload = {
  version: 1 as const,
  prompt: "Start the growth project?",
  acceptLabel: "Start project",
  rejectLabel: "Not yet",
};

describe("classifyRequestConfirmationReply", () => {
  it("matches reject and accept labels case-insensitively", () => {
    expect(classifyRequestConfirmationReply(payload, "Not yet")).toBe("reject");
    expect(classifyRequestConfirmationReply(payload, "not yet")).toBe("reject");
    expect(classifyRequestConfirmationReply(payload, "Start project")).toBe("approve");
    expect(classifyRequestConfirmationReply(payload, "start project")).toBe("approve");
  });

  it("returns null for unrelated replies", () => {
    expect(classifyRequestConfirmationReply(payload, "Please revise the plan first.")).toBeNull();
  });
});
