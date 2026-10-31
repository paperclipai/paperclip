import { describe, expect, it } from "vitest";
import { requiresSignedNativeReviewCredential } from "../routes/native-review-credential.js";

describe("native review credential boundary", () => {
  const review = { kind: "request_confirmation", payload: { target: { type: "custom", key: "native_completion_review" } } };

  it.each(["agent_key", "none", undefined])("requires a signed credential for agent source %s", (source) => {
    expect(requiresSignedNativeReviewCredential({ type: "agent", source }, review)).toBe(true);
  });

  it("leaves signed agents, board actors and other interactions unchanged", () => {
    expect(requiresSignedNativeReviewCredential({ type: "agent", source: "agent_jwt" }, review)).toBe(false);
    expect(requiresSignedNativeReviewCredential({ type: "board", source: "session" }, review)).toBe(false);
    expect(requiresSignedNativeReviewCredential({ type: "agent", source: "agent_key" }, { ...review, kind: "ask_user_questions" })).toBe(false);
    expect(requiresSignedNativeReviewCredential({ type: "agent", source: "agent_key" }, { kind: "request_confirmation", payload: { target: { type: "custom", key: "ordinary" } } })).toBe(false);
    expect(requiresSignedNativeReviewCredential({ type: "agent", source: "agent_key" }, { kind: "request_confirmation", payload: { target: { type: "issue", key: "native_completion_review" } } })).toBe(false);
    expect(requiresSignedNativeReviewCredential({ type: "agent", source: "agent_key" }, { kind: "request_confirmation", payload: null })).toBe(false);
  });
});
