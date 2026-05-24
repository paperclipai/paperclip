/**
 * Phase 2 Task 2.4b -- video-guild dispatch context builder.
 *
 * Unit tests for `buildVideoGuildContext`, the helper heartbeat.ts uses
 * to decide whether a guild dispatch is a video-stage run and (if so)
 * to construct the agent-fs `ArtifactsClient` that
 * `prepareGuildRunSandbox` mirrors prior-stage artifacts through.
 *
 * The helper is pure: it reads from an injected env bag rather than
 * `process.env` directly so tests don't need vi.stubEnv ceremony.
 * heartbeat.ts passes `process.env` as the env arg in production.
 */
import { describe, expect, it } from "vitest";

import { buildVideoGuildContext } from "../dispatch/video-guild-context.js";

describe("buildVideoGuildContext (Phase 2 Task 2.4b)", () => {
  const fullEnv = { AGENT_FS_URL: "http://agent-fs:8080", AGENT_FS_TOKEN: "secret-123" };

  it("returns null when issueTitle is null", () => {
    const result = buildVideoGuildContext({ issueTitle: null, env: fullEnv });
    expect(result).toBeNull();
  });

  it("returns null when issueTitle is undefined", () => {
    const result = buildVideoGuildContext({ issueTitle: undefined, env: fullEnv });
    expect(result).toBeNull();
  });

  it("returns null silently for non-video titles even when env vars are present", () => {
    const result = buildVideoGuildContext({
      issueTitle: "eng-typescript-bug",
      env: fullEnv,
    });
    expect(result).toBeNull();
  });

  it("returns null for a video-shaped title with an unknown stage (typo guard)", () => {
    // Stage must be one of research|strategy|copy|edit -- this matches
    // the same regex constraint VIDEO_ISSUE_TITLE_PATTERN enforces in
    // guild-worker-env.ts.
    const result = buildVideoGuildContext({
      issueTitle: "video-foo/campaign-42",
      env: fullEnv,
    });
    expect(result).toBeNull();
  });

  it("returns kind=video with parsed stage + requestId + artifacts client when both env vars are set", () => {
    const result = buildVideoGuildContext({
      issueTitle: "video-strategy/campaign-42",
      env: fullEnv,
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.kind).toBe("video");
    if (result.kind !== "video") return;
    expect(result.stage).toBe("strategy");
    expect(result.requestId).toBe("campaign-42");
    expect(typeof result.artifacts.fetchArtifact).toBe("function");
  });

  it("parses each pipeline stage (research/strategy/copy/edit) into the typed stage field", () => {
    for (const stage of ["research", "strategy", "copy", "edit"] as const) {
      const result = buildVideoGuildContext({
        issueTitle: `video-${stage}/req-x`,
        env: fullEnv,
      });
      expect(result).not.toBeNull();
      if (result === null) continue;
      if (result.kind !== "video") {
        throw new Error(`expected kind=video for stage ${stage}, got ${result.kind}`);
      }
      expect(result.stage).toBe(stage);
      expect(result.requestId).toBe("req-x");
    }
  });

  it("returns kind=degraded with missingEnv=[AGENT_FS_URL] when only AGENT_FS_URL is unset", () => {
    const result = buildVideoGuildContext({
      issueTitle: "video-copy/req-99",
      env: { AGENT_FS_TOKEN: "secret-123" },
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.kind).toBe("degraded");
    if (result.kind !== "degraded") return;
    expect(result.stage).toBe("copy");
    expect(result.requestId).toBe("req-99");
    expect(result.missingEnv).toEqual(["AGENT_FS_URL"]);
  });

  it("returns kind=degraded with missingEnv=[AGENT_FS_TOKEN] when only AGENT_FS_TOKEN is unset", () => {
    const result = buildVideoGuildContext({
      issueTitle: "video-edit/req-77",
      env: { AGENT_FS_URL: "http://agent-fs:8080" },
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.kind).toBe("degraded");
    if (result.kind !== "degraded") return;
    expect(result.missingEnv).toEqual(["AGENT_FS_TOKEN"]);
  });

  it("returns kind=degraded with both env-var names when both are missing", () => {
    const result = buildVideoGuildContext({
      issueTitle: "video-research/req-1",
      env: {},
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.kind).toBe("degraded");
    if (result.kind !== "degraded") return;
    expect(result.missingEnv).toEqual(["AGENT_FS_URL", "AGENT_FS_TOKEN"]);
  });

  it("treats whitespace-only env vars as missing (matches process.env trim convention)", () => {
    // `process.env.X?.trim() || fallback` is the codebase idiom; the
    // helper applies trim() so `"   "` is treated identically to unset.
    const result = buildVideoGuildContext({
      issueTitle: "video-strategy/req-1",
      env: { AGENT_FS_URL: "   ", AGENT_FS_TOKEN: "secret" },
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.kind).toBe("degraded");
    if (result.kind !== "degraded") return;
    expect(result.missingEnv).toEqual(["AGENT_FS_URL"]);
  });

  it("returns null when title has multi-segment requestId (typo guard)", () => {
    // The regex requires the request_id segment to not contain a slash
    // so `video-research/campaign-42/v2` fails to match cleanly rather
    // than silently swallowing the extra path segment.
    const result = buildVideoGuildContext({
      issueTitle: "video-research/campaign-42/v2",
      env: fullEnv,
    });
    expect(result).toBeNull();
  });
});
