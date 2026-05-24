import { describe, expect, it } from "vitest";
import {
  listAcpxSkills,
  syncAcpxSkills,
} from "@valadrien-os/adapter-acpx-local/server";

describe("acpx local skill sync", () => {
  const valadrienOsKey = "ValDola-stack/valadrien-os/valadrien-os";
  const createAgentKey = "ValDola-stack/valadrien-os/valadrien-os-create-agent";

  it("reports ACPX Claude skills as supported runtime-mounted state", async () => {
    const snapshot = await listAcpxSkills({
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "acpx_local",
      config: {
        agent: "claude",
        valadrienOsSkillSync: {
          desiredSkills: [valadrienOsKey],
        },
      },
    });

    expect(snapshot.adapterType).toBe("acpx_local");
    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.desiredSkills).toContain(valadrienOsKey);
    expect(snapshot.desiredSkills).toContain(createAgentKey);
    expect(snapshot.entries.find((entry) => entry.key === valadrienOsKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === valadrienOsKey)?.detail).toContain("ACPX Claude session");
    expect(snapshot.warnings).toEqual([]);
  });

  it("reports ACPX Codex skills with Codex home runtime detail", async () => {
    const snapshot = await syncAcpxSkills({
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "acpx_local",
      config: {
        agent: "codex",
        valadrienOsSkillSync: {
          desiredSkills: ["valadrien-os"],
        },
      },
    }, ["valadrien-os"]);

    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.desiredSkills).toContain(valadrienOsKey);
    expect(snapshot.desiredSkills).not.toContain("valadrien-os");
    expect(snapshot.entries.find((entry) => entry.key === valadrienOsKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === valadrienOsKey)?.detail).toContain("CODEX_HOME/skills/");
    expect(snapshot.warnings).toEqual([]);
  });

  it("keeps ACPX custom skill selection tracked but unsupported", async () => {
    const snapshot = await listAcpxSkills({
      agentId: "agent-3",
      companyId: "company-1",
      adapterType: "acpx_local",
      config: {
        agent: "custom",
        valadrienOsSkillSync: {
          desiredSkills: [valadrienOsKey],
        },
      },
    });

    expect(snapshot.supported).toBe(false);
    expect(snapshot.mode).toBe("unsupported");
    expect(snapshot.desiredSkills).toContain(valadrienOsKey);
    expect(snapshot.entries.find((entry) => entry.key === valadrienOsKey)?.desired).toBe(true);
    expect(snapshot.entries.find((entry) => entry.key === valadrienOsKey)?.detail).toContain("stored in ValadrienOs only");
    expect(snapshot.warnings).toContain(
      "Custom ACP commands do not expose a ValadrienOs skill integration contract yet; selected skills are tracked only.",
    );
  });
});
