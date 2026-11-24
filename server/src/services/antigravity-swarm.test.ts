import { describe, expect, it } from "vitest";
import { antigravitySwarmRefusal, requestedAntigravitySwarmCommentId } from "./antigravity-swarm.js";

const antigravity = { adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "antigravity", model: "gemini-3.8-flash-low" } };

describe("trusted /swarm for Google Antigravity", () => {
  it("is available only when the experimental flag is on, for a local Antigravity assignee", () => {
    expect(antigravitySwarmRefusal({ enabled: true, agent: antigravity })).toBeNull();
    expect(antigravitySwarmRefusal({ enabled: false, agent: antigravity })).toMatch(/not turned on/);
    expect(antigravitySwarmRefusal({ enabled: true, agent: null })).toMatch(/Google Antigravity agent/);
    expect(antigravitySwarmRefusal({ enabled: true, agent: { adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude" } } }))
      .toMatch(/Google Antigravity agent/);
    expect(antigravitySwarmRefusal({ enabled: true, agent: antigravity, remote: true })).toMatch(/this computer/);
  });

  it("reads a swarm request only from the wake's structured marker, never from comment text", () => {
    const id = "6f1c1b0e-5a52-4b0a-9a51-0d6c9c3b2f11";
    expect(requestedAntigravitySwarmCommentId({ antigravitySwarmCommentId: id })).toBe(id);
    expect(requestedAntigravitySwarmCommentId({ commentId: id, wakeCommentId: id })).toBeNull();
    expect(requestedAntigravitySwarmCommentId({ antigravitySwarmCommentId: "/swarm do it" })).toBeNull();
    expect(requestedAntigravitySwarmCommentId(null)).toBeNull();
  });
});
