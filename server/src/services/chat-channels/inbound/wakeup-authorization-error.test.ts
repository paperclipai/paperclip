import { describe, expect, it } from "vitest";
import { forbidden } from "../../../errors.js";
import { chatWakeAuthorityDenied, safeChatWakeAuthorityReason } from "./wakeup-authorization-error.js";

describe("safe chat wake authority reason", () => {
  it("retains only the stable category from a known authority refusal", () => {
    expect(safeChatWakeAuthorityReason(chatWakeAuthorityDenied("source_receipt"))).toBe("source_receipt");
  });
  it.each([
    forbidden("private provider response", { code: "chat_action_authorization_changed", authorityReason: "private-source-payload" }),
    forbidden("private provider response", { code: "another_error", authorityReason: "source_receipt" }),
    { details: { code: "chat_action_authorization_changed", authorityReason: "source_receipt" } },
  ])("does not copy arbitrary error fields or untrusted error shapes", error => {
    expect(safeChatWakeAuthorityReason(error)).toBeUndefined();
  });
});
