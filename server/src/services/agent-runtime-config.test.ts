import { describe, expect, it } from "vitest";
import {
  buildHeartbeatAutoPauseRuntimeConfig,
  buildHeartbeatAutoResumeRuntimeConfig,
  HEARTBEAT_AUTOPAUSE_GUARD_VERSION,
  HEARTBEAT_AUTOPAUSE_SOURCE_ISSUE_ID,
} from "./agent-runtime-config.js";

const digest = `sha256:${"a".repeat(64)}`;
const fingerprint = `sha256:${"b".repeat(64)}`;
const firstRunId = "11111111-1111-4111-8111-111111111111";
const lastRunId = "22222222-2222-4222-8222-222222222222";

describe("agent runtimeConfig heartbeat auto-pause helpers", () => {
  it("preserves existing runtimeConfig keys while recording a sanitized pauseReason", () => {
    const result = buildHeartbeatAutoPauseRuntimeConfig({
      heartbeat: {
        enabled: true,
        intervalSec: 900,
        maxConcurrentRuns: 1,
      },
      modelProfiles: {
        cheap: {
          enabled: true,
          adapterConfig: { model: "small" },
        },
      },
      customFlag: "kept",
    }, {
      code: "monthly_usage_limit",
      adapter: "claude_local",
      consecutiveErrorCount: 3,
      firstRunId,
      lastRunId,
      sampleDigest: digest,
      createdAt: "2026-05-14T00:00:00.000Z",
      fingerprint,
    });

    expect(result.changed).toBe(true);
    expect(result.runtimeConfig).toMatchObject({
      heartbeat: {
        enabled: false,
        intervalSec: 900,
        maxConcurrentRuns: 1,
      },
      modelProfiles: {
        cheap: {
          enabled: true,
          adapterConfig: { model: "small" },
        },
      },
      customFlag: "kept",
      pauseReason: {
        code: "monthly_usage_limit",
        adapter: "claude_local",
        consecutiveErrorCount: 3,
        firstRunId,
        lastRunId,
        sampleDigest: digest,
        createdAt: "2026-05-14T00:00:00.000Z",
        guardVersion: HEARTBEAT_AUTOPAUSE_GUARD_VERSION,
        sourceIssueId: HEARTBEAT_AUTOPAUSE_SOURCE_ISSUE_ID,
        fingerprint,
        previousHeartbeatEnabled: true,
      },
    });
    expect(JSON.stringify(result.runtimeConfig)).not.toContain("Bearer");
    expect(JSON.stringify(result.runtimeConfig)).not.toContain("sk-");
  });

  it("is idempotent for the same run and digest", () => {
    const first = buildHeartbeatAutoPauseRuntimeConfig({ heartbeat: { enabled: true } }, {
      code: "quota_exceeded",
      adapter: "claude_local",
      consecutiveErrorCount: 3,
      firstRunId,
      lastRunId,
      sampleDigest: digest,
      createdAt: "2026-05-14T00:00:00.000Z",
    });

    const second = buildHeartbeatAutoPauseRuntimeConfig(first.runtimeConfig, {
      code: "quota_exceeded",
      adapter: "claude_local",
      consecutiveErrorCount: 3,
      firstRunId,
      lastRunId,
      sampleDigest: digest,
      createdAt: "2026-05-14T01:00:00.000Z",
    });

    expect(second.changed).toBe(false);
    expect(second.runtimeConfig).toEqual(first.runtimeConfig);
  });

  it("rejects raw secret-like payload fields and non-digest samples", () => {
    expect(() => buildHeartbeatAutoPauseRuntimeConfig({}, {
      code: "invalid_api_key",
      adapter: "claude_local",
      consecutiveErrorCount: 3,
      firstRunId,
      lastRunId,
      sampleDigest: "Authorization: Bearer sk-test",
      createdAt: "2026-05-14T00:00:00.000Z",
    })).toThrow("sampleDigest must be a sha256 digest");

    expect(() => buildHeartbeatAutoPauseRuntimeConfig({}, {
      code: "auth_failed",
      adapter: "claude_local",
      consecutiveErrorCount: 3,
      firstRunId,
      lastRunId,
      sampleDigest: digest,
      createdAt: "2026-05-14T00:00:00.000Z",
      rawMessage: "Authorization: Bearer sk-test",
    } as never)).toThrow("pauseReason.rawMessage is not allowed");
  });

  it("archives auto-pause metadata and records resume audit fields", () => {
    const paused = buildHeartbeatAutoPauseRuntimeConfig({
      heartbeat: {
        enabled: true,
        intervalSec: 900,
      },
    }, {
      code: "rate_limit_exceeded",
      adapter: "codex_local",
      consecutiveErrorCount: 3,
      firstRunId,
      lastRunId,
      sampleDigest: digest,
      createdAt: "2026-05-14T00:00:00.000Z",
    });

    const resumed = buildHeartbeatAutoResumeRuntimeConfig(paused.runtimeConfig, {
      resumeReason: "provider_limit_resolved",
      resumedBy: {
        type: "agent",
        id: "704db54c-f5c1-48cd-b89d-558e87534f38",
      },
      resumedAt: "2026-05-14T00:30:00.000Z",
    });

    expect(resumed.changed).toBe(true);
    expect(resumed.runtimeConfig.pauseReason).toBeUndefined();
    expect(resumed.runtimeConfig).toMatchObject({
      heartbeat: {
        enabled: true,
        intervalSec: 900,
      },
      lastPauseReason: paused.runtimeConfig.pauseReason,
      resumeReason: "provider_limit_resolved",
      resumedBy: {
        type: "agent",
        id: "704db54c-f5c1-48cd-b89d-558e87534f38",
      },
      resumedAt: "2026-05-14T00:30:00.000Z",
    });

    const second = buildHeartbeatAutoResumeRuntimeConfig(resumed.runtimeConfig, {
      resumeReason: "provider_limit_resolved",
      resumedBy: {
        type: "agent",
        id: "704db54c-f5c1-48cd-b89d-558e87534f38",
      },
      resumedAt: "2026-05-14T00:30:00.000Z",
    });
    expect(second.changed).toBe(false);
  });
});
