import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { applyConnectorSkills, isCliSkillFileAdapter, prepareConnectorSkillDelivery } from "../services/connector-runtime.js";
import { removeRuntimeAssetTree } from "../services/native-runtime/runtime-asset-retention.js";

function slackAssignment(channelId: string, requesterId: string, authorizationRevision: string) {
  return {
    key: "slack",
    label: "Slack",
    skillKey: "paperclipai/paperclip/slack",
    resources: [{
      id: "endpoint-1",
      label: "fixture-bot",
      connectionId: "connection-1",
      metadata: { workspaceId: "T0FIXTURE", channelId, requesterId, authorizationRevision },
    }],
    tools: [{ name: "slack_read", description: "Read messages", inputSchema: { type: "object" } }],
  };
}

describe("connector run-scoped metadata", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "connector-run-scoped-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await removeRuntimeAssetTree(home);
  });

  it("keeps one skill bundle across Slack conversations for CLI adapters and sends each conversation's identifiers in the run prompt", async () => {
    const inPrompt = { runScopedMetadataInPrompt: true };
    const first = await applyConnectorSkills({ engine: "cli" }, [], [slackAssignment("D0FIRST", "U0FIRST", "rev-first")], inPrompt);
    const second = await applyConnectorSkills({ engine: "cli" }, [], [slackAssignment("C0SECOND", "U0SECOND", "rev-second")], inPrompt);

    expect(second.paperclipRuntimeSkills[0].source).toBe(first.paperclipRuntimeSkills[0].source);
    expect(second.paperclipConnectorSkillDigest).toBe(first.paperclipConnectorSkillDigest);
    const markdown = await readFile(path.join(first.paperclipRuntimeSkills[0].source, "SKILL.md"), "utf8");
    expect(markdown).toContain("T0FIXTURE");
    expect(markdown).toContain("endpoint-1");
    for (const runValue of ["D0FIRST", "U0FIRST", "rev-first"]) expect(markdown).not.toContain(runValue);

    for (const adapterType of ["claude_local", "codex_local", "kimi_local"]) {
      expect(isCliSkillFileAdapter(adapterType, { engine: "cli" })).toBe(true);
      const delivery = await prepareConnectorSkillDelivery(second, adapterType);
      expect(delivery.config.paperclipConnectorRunContext).toBeNull();
      for (const resumedSession of [false, true]) {
        const prompt = renderPaperclipWakePrompt({ connectorSkillInstructions: delivery.instructions }, { resumedSession });
        for (const runValue of ["C0SECOND", "U0SECOND", "rev-second", "endpoint-1"]) expect(prompt).toContain(runValue);
        expect(prompt).not.toContain("D0FIRST");
      }
    }
  });

  it("keeps the identifiers in the skill for the runner and shared-home adapters", async () => {
    for (const adapterType of ["paperclip_runner", "cursor_local"]) {
      const options = { runScopedMetadataInPrompt: isCliSkillFileAdapter(adapterType, { engine: "cli" }) };
      expect(options.runScopedMetadataInPrompt).toBe(false);
      const first = await applyConnectorSkills({ engine: "cli" }, [], [slackAssignment("D0FIRST", "U0FIRST", "rev-first")], options);
      const second = await applyConnectorSkills({ engine: "cli" }, [], [slackAssignment("C0SECOND", "U0SECOND", "rev-second")], options);
      expect(second.paperclipRuntimeSkills[0].source).not.toBe(first.paperclipRuntimeSkills[0].source);
      expect(second.paperclipConnectorRunContext).toBeNull();
      const markdown = await readFile(path.join(second.paperclipRuntimeSkills[0].source, "SKILL.md"), "utf8");
      for (const runValue of ["C0SECOND", "U0SECOND", "rev-second"]) expect(markdown).toContain(runValue);
      const delivery = await prepareConnectorSkillDelivery(second, adapterType);
      expect(delivery.instructions).toContain("C0SECOND");
    }
  });

  it("leaves connectors without run-scoped metadata unchanged", async () => {
    const assignment = {
      key: "agentmail",
      label: "AgentMail",
      skillKey: "paperclipai/paperclip/agentmail",
      resources: [{ id: "inbox-1", label: "inbox@example.com", connectionId: "connection-2" }],
      tools: [],
    };
    const configured = await applyConnectorSkills({ engine: "cli" }, [], [assignment], { runScopedMetadataInPrompt: true });
    expect(configured.paperclipConnectorRunContext).toBeNull();
    const markdown = await readFile(path.join(configured.paperclipRuntimeSkills[0].source, "SKILL.md"), "utf8");
    expect(markdown).toContain("inbox@example.com");
    expect((await prepareConnectorSkillDelivery(configured, "claude_local")).instructions).toBe("");
  });
});
