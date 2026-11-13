import { describe, expect, it } from "vitest";
import { ISSUE_CHAT_BOOTSTRAP_MAX_IDS } from "../constants.js";
import { issueChatBootstrapQuerySchema } from "./issue.js";

describe("issueChatBootstrapQuerySchema", () => {
  it("accepts UUIDs and task identifiers, normalized and deduplicated", () => {
    const uuid = "5C0F1C2E-1111-4222-8333-444455556666";
    expect(issueChatBootstrapQuerySchema.parse({ ids: `${uuid}, abc-12,ABC-12,${uuid.toLowerCase()}` })).toEqual({
      ids: [uuid.toLowerCase(), "ABC-12"],
    });
  });

  it("rejects values that are neither a UUID nor an identifier", () => {
    expect(issueChatBootstrapQuerySchema.safeParse({ ids: "abc-12,../etc" }).success).toBe(false);
    expect(issueChatBootstrapQuerySchema.safeParse({ ids: "" }).success).toBe(false);
  });

  it("bounds one request and allows no other query keys", () => {
    const ids = Array.from({ length: ISSUE_CHAT_BOOTSTRAP_MAX_IDS + 1 }, (_, i) => `ABC-${i + 1}`).join(",");
    expect(issueChatBootstrapQuerySchema.safeParse({ ids }).success).toBe(false);
    expect(issueChatBootstrapQuerySchema.safeParse({ ids: "ABC-1", extra: "1" }).success).toBe(false);
  });
});
