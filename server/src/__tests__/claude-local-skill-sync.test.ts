import { describe, expect, it } from "vitest";
import {
  listClaudeSkills,
  syncClaudeSkills,
} from "@paperclipai/adapter-claude-local/server";

describe("claude local skill sync", () => {
  it("defaults to mounting all built-in Paperclip skills when no explicit selection exists", async () => {
    const snapshot = await listClaudeSkills({
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "claude_local",
      config: {},
    });

    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.supported).toBe(true);
    expect(snapshot.desiredSkills).toContain("paperclip");
    expect(snapshot.entries.find((entry) => entry.name === "paperclip")?.state).toBe("configured");
  });

  it("respects an explicit desired skill list without mutating a persistent home", async () => {
    const snapshot = await syncClaudeSkills({
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        paperclipSkillSync: {
          desiredSkills: ["paperclip"],
        },
      },
    }, ["paperclip"]);

    expect(snapshot.desiredSkills).toEqual(["paperclip"]);
    expect(snapshot.entries.find((entry) => entry.name === "paperclip")?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.name === "paperclip-create-agent")?.state).toBe("available");
  });
});
