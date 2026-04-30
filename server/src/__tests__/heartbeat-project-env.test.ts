import { describe, expect, it, vi } from "vitest";
import { buildSkillMentionHref, isUuidLike } from "@paperclipai/shared";
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
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: {
        SHARED_KEY: "project",
        PROJECT_ONLY: "project-only",
      },
      secretKeys: new Set(["PROJECT_SECRET"]),
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
  });

  it("skips project env resolution when the project has no bindings", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
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

  // Regression: malformed mentions like `skill://paperclip-create-agent` (slug
  // as host instead of `skill://<uuid>?s=<slug>`) used to flow into a Postgres
  // uuid-typed `inArray` query and crash run startup with
  // `invalid input syntax for type uuid`. The resolver now filters extracted
  // ids through `isUuidLike` before the query.
  it("filters slug-form skill mentions out before they reach a uuid query", () => {
    const validUuid = "b405cd52-ddfb-490a-a769-7a34a0f26ea8";
    const validHref = buildSkillMentionHref(validUuid, "real-skill");
    const malformedHref = "skill://paperclip-create-agent";

    const extracted = extractMentionedSkillIdsFromSources([
      `Real mention [/real-skill](${validHref})`,
      `Malformed mention [/paperclip-create-agent](${malformedHref})`,
    ]);
    expect(extracted).toContain(validUuid);
    expect(extracted).toContain("paperclip-create-agent");

    const safeForUuidQuery = extracted.filter(isUuidLike);
    expect(safeForUuidQuery).toEqual([validUuid]);
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
