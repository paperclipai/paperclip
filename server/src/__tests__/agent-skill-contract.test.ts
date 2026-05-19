import { describe, expect, it } from "vitest";
import {
  agentSkillEntrySchema,
  agentSkillSnapshotSchema,
} from "@paperclipai/shared/validators/adapter-skills";

describe("agent skill contract", () => {
  it("accepts optional provenance metadata on skill entries", () => {
    expect(agentSkillEntrySchema.parse({
      key: "crack-python",
      runtimeName: "crack-python",
      desired: false,
      managed: false,
      state: "external",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: "~/.claude/skills",
      readOnly: true,
      detail: "Installed outside Paperclip management.",
    })).toMatchObject({
      origin: "user_installed",
      locationLabel: "~/.claude/skills",
      readOnly: true,
    });
  });

  it("remains backward compatible with snapshots that omit provenance metadata", () => {
    expect(agentSkillSnapshotSchema.parse({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: [],
      entries: [{
        key: "paperclipai/paperclip/paperclip",
        runtimeName: "paperclip",
        desired: true,
        managed: true,
        state: "configured",
      }],
      warnings: [],
    })).toMatchObject({
      adapterType: "claude_local",
      entries: [{
        key: "paperclipai/paperclip/paperclip",
        state: "configured",
      }],
    });
  });
});
