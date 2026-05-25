/**
 * Phase 2 Task 2.1 -- video-guild dispatcher env-var pass-through.
 *
 * Verifies that `buildGuildWorkerEnv` extracts the stage + request_id
 * from an issue title of the form `video-<stage>/<request_id>` and
 * emits `VIDEO_AD_STAGE` + `VIDEO_AD_REQUEST_ID` env vars for the
 * worker. Non-matching titles (e.g. eng-guild issues) are unaffected.
 *
 * NOTE: the function signature is `{ agent, sandboxDir, issueTitle? }`.
 * The plan's test sketch used `{ issue, guildSlug }` which is the call
 * site's shape, not the function's. This file adapts the test to the
 * function's actual signature per the TDD rule "adapt the test, not
 * the function".
 */
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildGuildWorkerEnv } from "../dispatch/guild-worker-env.js";

const guildAgent = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "video-guild",
  kind: "guild" as const,
};
const engGuildAgent = {
  id: "00000000-0000-0000-0000-000000000002",
  name: "eng-guild",
  kind: "guild" as const,
};
const sandboxDir = "/tmp/paperclip-guild-run-vid-XXXXXX";

describe("video-guild worker env", () => {
  it("passes VIDEO_AD_REQUEST_ID + VIDEO_AD_STAGE=research when issue title starts with video-research/", () => {
    const env = buildGuildWorkerEnv({
      agent: guildAgent,
      sandboxDir,
      issueTitle: "video-research/abc-123",
    });
    expect(env.VIDEO_AD_REQUEST_ID).toBe("abc-123");
    expect(env.VIDEO_AD_STAGE).toBe("research");
  });

  it("passes VIDEO_AD_STAGE=strategy for video-strategy/ prefix", () => {
    const env = buildGuildWorkerEnv({
      agent: guildAgent,
      sandboxDir,
      issueTitle: "video-strategy/xyz-789",
    });
    expect(env.VIDEO_AD_STAGE).toBe("strategy");
    expect(env.VIDEO_AD_REQUEST_ID).toBe("xyz-789");
  });

  it("passes VIDEO_AD_STAGE=copy for video-copy/ prefix", () => {
    const env = buildGuildWorkerEnv({
      agent: guildAgent,
      sandboxDir,
      issueTitle: "video-copy/xyz-789",
    });
    expect(env.VIDEO_AD_STAGE).toBe("copy");
    expect(env.VIDEO_AD_REQUEST_ID).toBe("xyz-789");
  });

  it("passes VIDEO_AD_STAGE=edit for video-edit/ prefix", () => {
    const env = buildGuildWorkerEnv({
      agent: guildAgent,
      sandboxDir,
      issueTitle: "video-edit/xyz-789",
    });
    expect(env.VIDEO_AD_STAGE).toBe("edit");
    expect(env.VIDEO_AD_REQUEST_ID).toBe("xyz-789");
  });

  it("does not set VIDEO_AD_* for non-video guild issues", () => {
    const env = buildGuildWorkerEnv({
      agent: engGuildAgent,
      sandboxDir,
      issueTitle: "eng-typescript-bug",
    });
    expect(env.VIDEO_AD_REQUEST_ID).toBeUndefined();
    expect(env.VIDEO_AD_STAGE).toBeUndefined();
  });

  it("does not set VIDEO_AD_* when issueTitle is omitted", () => {
    const env = buildGuildWorkerEnv({
      agent: guildAgent,
      sandboxDir,
    });
    expect(env.VIDEO_AD_REQUEST_ID).toBeUndefined();
    expect(env.VIDEO_AD_STAGE).toBeUndefined();
  });

  it("does not set VIDEO_AD_* for unknown stages (e.g. video-foo/...)", () => {
    const env = buildGuildWorkerEnv({
      agent: guildAgent,
      sandboxDir,
      issueTitle: "video-foo/bar-123",
    });
    expect(env.VIDEO_AD_REQUEST_ID).toBeUndefined();
    expect(env.VIDEO_AD_STAGE).toBeUndefined();
  });

  it("does not set VIDEO_AD_* when request_id segment contains a slash (e.g. video-research/abc/def)", () => {
    const env = buildGuildWorkerEnv({
      agent: guildAgent,
      sandboxDir,
      issueTitle: "video-research/abc/def",
    });
    expect(env.VIDEO_AD_REQUEST_ID).toBeUndefined();
    expect(env.VIDEO_AD_STAGE).toBeUndefined();
  });

  describe("VIDEO_AD_ARTIFACTS_DIR (Task 2.4b)", () => {
    it("sets VIDEO_AD_ARTIFACTS_DIR=<sandboxDir>/artifacts when issue title matches video pattern", () => {
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-research/abc-123",
      });
      expect(env.VIDEO_AD_ARTIFACTS_DIR).toBe(path.join(sandboxDir, "artifacts"));
    });

    it("sets VIDEO_AD_ARTIFACTS_DIR for every recognised stage", () => {
      for (const stage of ["research", "strategy", "copy", "edit"]) {
        const env = buildGuildWorkerEnv({
          agent: guildAgent,
          sandboxDir,
          issueTitle: `video-${stage}/req-1`,
        });
        expect(env.VIDEO_AD_ARTIFACTS_DIR).toBe(path.join(sandboxDir, "artifacts"));
      }
    });

    it("does NOT set VIDEO_AD_ARTIFACTS_DIR for non-video guild issues (eng-guild)", () => {
      const env = buildGuildWorkerEnv({
        agent: engGuildAgent,
        sandboxDir,
        issueTitle: "eng-typescript-bug",
      });
      expect(env.VIDEO_AD_ARTIFACTS_DIR).toBeUndefined();
    });

    it("does NOT set VIDEO_AD_ARTIFACTS_DIR when issueTitle is omitted on a video-guild agent", () => {
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
      });
      expect(env.VIDEO_AD_ARTIFACTS_DIR).toBeUndefined();
    });

    it("does NOT set VIDEO_AD_ARTIFACTS_DIR for unrecognised video-* stages", () => {
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-foo/bar-123",
      });
      expect(env.VIDEO_AD_ARTIFACTS_DIR).toBeUndefined();
    });
  });

  /**
   * Bug G fix -- forward narrow allowlist of third-party API keys from
   * the paperclip process env to the worker env, but only for video-guild
   * issues. The dispatcher's worker had been failing on ElevenLabs voice
   * synthesis because the key, though set in the paperclip container,
   * was never propagated to the spawned worker's env.
   */
  describe("VIDEO_WORKER_FORWARDED_ENV_KEYS allowlist (Bug G)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("forwards ELEVENLABS_API_KEY when process.env has it AND issue is a video stage", () => {
      vi.stubEnv("ELEVENLABS_API_KEY", "test-key-xyz");
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-research/abc-123",
      });
      expect(env.ELEVENLABS_API_KEY).toBe("test-key-xyz");
    });

    it("does NOT forward ELEVENLABS_API_KEY for non-video guild issues (eng-task)", () => {
      vi.stubEnv("ELEVENLABS_API_KEY", "test-key-xyz");
      const env = buildGuildWorkerEnv({
        agent: engGuildAgent,
        sandboxDir,
        issueTitle: "eng-task-1",
      });
      expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    });

    it("does NOT forward ELEVENLABS_API_KEY when issueTitle is null", () => {
      vi.stubEnv("ELEVENLABS_API_KEY", "test-key-xyz");
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: null,
      });
      expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    });

    it("does NOT forward ELEVENLABS_API_KEY when agent.kind !== 'guild'", () => {
      vi.stubEnv("ELEVENLABS_API_KEY", "test-key-xyz");
      const env = buildGuildWorkerEnv({
        agent: {
          id: "00000000-0000-0000-0000-000000000003",
          name: "some-worker",
          kind: "worker" as never,
        },
        sandboxDir,
        issueTitle: "video-research/abc-123",
      });
      expect(env).toEqual({});
    });

    it("does NOT forward ELEVENLABS_API_KEY when process.env.ELEVENLABS_API_KEY is unset", () => {
      vi.stubEnv("ELEVENLABS_API_KEY", undefined as unknown as string);
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-research/abc-123",
      });
      expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    });

    it("does NOT forward ELEVENLABS_API_KEY when process.env.ELEVENLABS_API_KEY is an empty string", () => {
      vi.stubEnv("ELEVENLABS_API_KEY", "");
      const env = buildGuildWorkerEnv({
        agent: guildAgent,
        sandboxDir,
        issueTitle: "video-research/abc-123",
      });
      expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    });
  });
});
