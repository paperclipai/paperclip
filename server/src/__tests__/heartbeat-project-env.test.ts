import { describe, expect, it, vi } from "vitest";
import { buildSkillMentionHref } from "@paperclipai/shared";
import {
  applyRunScopedMentionedSkillKeys,
  extractMentionedSkillIdsFromSources,
  resolveExecutionRunAdapterConfig,
} from "../services/heartbeat.ts";

describe("resolveExecutionRunAdapterConfig", () => {
  it("overlays project env on top of agent env and unions secret keys", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: {
        env: {
          SHARED_KEY: "agent",
          AGENT_ONLY: "agent-only",
        },
        other: "value",
      },
      secretKeys: new Set(["AGENT_SECRET"]),
      manifest: [
        {
          configPath: "env.AGENT_SECRET",
          envKey: "AGENT_SECRET",
          secretId: "secret-agent",
          secretKey: "agent-secret",
          version: 1,
          provider: "local_encrypted",
          outcome: "success",
        },
      ],
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: {
        SHARED_KEY: "project",
        PROJECT_ONLY: "project-only",
      },
      secretKeys: new Set(["PROJECT_SECRET"]),
      manifest: [
        {
          configPath: "env.PROJECT_SECRET",
          envKey: "PROJECT_SECRET",
          secretId: "secret-project",
          secretKey: "project-secret",
          version: 1,
          provider: "local_encrypted",
          outcome: "success",
        },
      ],
    });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: { SHARED_KEY: "agent" } },
      projectEnv: { SHARED_KEY: "project" },
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(result.resolvedConfig).toMatchObject({
      other: "value",
      env: {
        SHARED_KEY: "project",
        AGENT_ONLY: "agent-only",
        PROJECT_ONLY: "project-only",
      },
    });
    expect(Array.from(result.secretKeys).sort()).toEqual(["AGENT_SECRET", "PROJECT_SECRET"]);
    expect(result.secretManifest.map((entry) => entry.secretId).sort()).toEqual([
      "secret-agent",
      "secret-project",
    ]);
    expect(JSON.stringify(result.secretManifest)).not.toContain("agent-only");
    expect(JSON.stringify(result.secretManifest)).not.toContain("project-only");
  });

  it("skips project env resolution when the project has no bindings", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn();

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(result.resolvedConfig.env).toEqual({ AGENT_ONLY: "agent-only" });
    expect(result.secretManifest).toEqual([]);
    expect(resolveEnvBindings).not.toHaveBeenCalled();
  });
});

describe("extractMentionedSkillIdsFromSources", () => {
  it("collects explicit skill mention ids across issue sources", () => {
    const releaseHref = buildSkillMentionHref("skill-1", "release-changelog");
    const browserHref = buildSkillMentionHref("skill-2", "agent-browser");

    expect(
      extractMentionedSkillIdsFromSources([
        `Please use [/release-changelog](${releaseHref})`,
        `And also [/agent-browser](${browserHref})`,
        `Duplicate mention [/release-changelog](${releaseHref})`,
      ]),
    ).toEqual(["skill-1", "skill-2"]);
  });
});

describe("applyRunScopedMentionedSkillKeys", () => {
  it("adds mentioned skills without mutating the original config", () => {
    const originalConfig = {
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/paperclip"],
      },
    };

    const updatedConfig = applyRunScopedMentionedSkillKeys(originalConfig, [
      "company/company-1/release-changelog",
      "paperclipai/paperclip/paperclip",
      "company/company-1/release-changelog",
    ]);

    expect(updatedConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: [
          "paperclipai/paperclip/paperclip",
          "company/company-1/release-changelog",
        ],
      },
    });
    expect(originalConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/paperclip"],
      },
    });
  });
});
