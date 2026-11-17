import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { applyConnectorSkills, prepareConnectorSkillDelivery } from "../services/connector-runtime.js";
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

  it("keeps one skill bundle across Slack conversations and sends each conversation's identifiers in the run prompt", async () => {
    const first = await applyConnectorSkills({ engine: "cli" }, [], [slackAssignment("D0FIRST", "U0FIRST", "rev-first")]);
    const second = await applyConnectorSkills({ engine: "cli" }, [], [slackAssignment("C0SECOND", "U0SECOND", "rev-second")]);

    expect(second.paperclipRuntimeSkills[0].source).toBe(first.paperclipRuntimeSkills[0].source);
    expect(second.paperclipConnectorSkillDigest).toBe(first.paperclipConnectorSkillDigest);
    const markdown = await readFile(path.join(first.paperclipRuntimeSkills[0].source, "SKILL.md"), "utf8");
    expect(markdown).toContain("T0FIXTURE");
    expect(markdown).toContain("endpoint-1");
    for (const runValue of ["D0FIRST", "U0FIRST", "rev-first"]) expect(markdown).not.toContain(runValue);

    for (const adapterType of ["claude_local", "codex_local", "paperclip_runner", "cursor_local"]) {
      const delivery = await prepareConnectorSkillDelivery(second, adapterType);
      expect(delivery.config.paperclipConnectorRunContext).toBeNull();
      for (const resumedSession of [false, true]) {
        const prompt = renderPaperclipWakePrompt({ connectorSkillInstructions: delivery.instructions }, { resumedSession });
        for (const runValue of ["C0SECOND", "U0SECOND", "rev-second", "endpoint-1"]) expect(prompt).toContain(runValue);
        expect(prompt).not.toContain("D0FIRST");
      }
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
    const configured = await applyConnectorSkills({ engine: "cli" }, [], [assignment]);
    expect(configured.paperclipConnectorRunContext).toBeNull();
    const markdown = await readFile(path.join(configured.paperclipRuntimeSkills[0].source, "SKILL.md"), "utf8");
    expect(markdown).toContain("inbox@example.com");
    expect((await prepareConnectorSkillDelivery(configured, "claude_local")).instructions).toBe("");
  });
});
