import { describe, expect, it } from "vitest";
import {
  listAcpxSkills,
  syncAcpxSkills,
} from "@paperclipai/adapter-acpx-local/server";

describe("acpx local skill sync", () => {
  const paperclipKey = "paperclipai/paperclip/paperclip";
  const createAgentKey = "paperclipai/paperclip/paperclip-create-agent";

  it("reports ACPX Claude skills as supported runtime-mounted state", async () => {
    const snapshot = await listAcpxSkills({
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "acpx_local",
      config: {
        agent: "claude",
        paperclipSkillSync: {
          desiredSkills: [paperclipKey],
        },
      },
    });

    expect(snapshot.adapterType).toBe("acpx_local");
    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.desiredSkills).toContain(paperclipKey);
    expect(snapshot.desiredSkills).toContain(createAgentKey);
    expect(snapshot.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === paperclipKey)?.detail).toContain("ACPX Claude session");
    expect(snapshot.warnings).toEqual([]);
  });

  it("reports ACPX Codex skills with Codex home runtime detail", async () => {
    const snapshot = await syncAcpxSkills({
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "acpx_local",
      config: {
        agent: "codex",
        paperclipSkillSync: {
          desiredSkills: ["paperclip"],
        },
      },
    }, ["paperclip"]);

    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.desiredSkills).toContain(paperclipKey);
    expect(snapshot.desiredSkills).not.toContain("paperclip");
    expect(snapshot.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === paperclipKey)?.detail).toContain("CODEX_HOME/skills/");
    expect(snapshot.warnings).toEqual([]);
  });

  it("keeps ACPX custom skill selection tracked but unsupported", async () => {
    const snapshot = await listAcpxSkills({
      agentId: "agent-3",
      companyId: "company-1",
      adapterType: "acpx_local",
      config: {
        agent: "custom",
        paperclipSkillSync: {
          desiredSkills: [paperclipKey],
        },
      },
    });

    expect(snapshot.supported).toBe(false);
    expect(snapshot.mode).toBe("unsupported");
    expect(snapshot.desiredSkills).toContain(paperclipKey);
    expect(snapshot.entries.find((entry) => entry.key === paperclipKey)?.desired).toBe(true);
    expect(snapshot.entries.find((entry) => entry.key === paperclipKey)?.detail).toContain("stored in Paperclip only");
    expect(snapshot.warnings).toContain(
      "Custom ACP commands do not expose a Paperclip skill integration contract yet; selected skills are tracked only.",
    );
  });
});
