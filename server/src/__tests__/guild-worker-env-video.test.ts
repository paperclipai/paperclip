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
import { describe, expect, it } from "vitest";

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
});
