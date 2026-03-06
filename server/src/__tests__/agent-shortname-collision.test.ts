import { describe, expect, it } from "vitest";
import { hasAgentShortnameCollision } from "../services/agents.ts";

describe("hasAgentShortnameCollision", () => {
  it("detects collisions by normalized shortname", () => {
    const collision = hasAgentShortnameCollision("Codex Coder", [
      { id: "a1", name: "codex-coder", status: "idle" },
    ]);
    expect(collision).toBe(true);
  });

  it("ignores terminated agents", () => {
    const collision = hasAgentShortnameCollision("Codex Coder", [
      { id: "a1", name: "codex-coder", status: "terminated" },
    ]);
    expect(collision).toBe(false);
  });

  it("ignores the excluded agent id", () => {
    const collision = hasAgentShortnameCollision(
      "Codex Coder",
      [
        { id: "a1", name: "codex-coder", status: "idle" },
        { id: "a2", name: "other-agent", status: "idle" },
      ],
      { excludeAgentId: "a1" },
    );
    expect(collision).toBe(false);
  });

  it("does not collide when candidate has no shortname", () => {
    const collision = hasAgentShortnameCollision("!!!", [
      { id: "a1", name: "codex-coder", status: "idle" },
    ]);
    expect(collision).toBe(false);
  });
});
