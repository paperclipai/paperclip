import { describe, expect, it } from "vitest";
import { agentRuntimeConfigSchema } from "./agent.js";

const digest = `sha256:${"a".repeat(64)}`;

describe("agentRuntimeConfigSchema", () => {
  it("accepts heartbeat auto-pause and resume audit metadata", () => {
    const parsed = agentRuntimeConfigSchema.parse({
      heartbeat: {
        enabled: false,
        intervalSec: 900,
      },
      pauseReason: {
        code: "monthly_usage_limit",
        adapter: "claude_local",
        consecutiveErrorCount: 3,
        firstRunId: "11111111-1111-4111-8111-111111111111",
        lastRunId: "22222222-2222-4222-8222-222222222222",
        sampleDigest: digest,
        createdAt: "2026-05-14T00:00:00.000Z",
        guardVersion: "heartbeat-error-autopause/v1",
        sourceIssueId: "ARI-103",
        previousHeartbeatEnabled: true,
      },
      resumeReason: "provider_limit_resolved",
      resumedBy: {
        type: "agent",
        id: "704db54c-f5c1-48cd-b89d-558e87534f38",
      },
      resumedAt: "2026-05-14T00:30:00.000Z",
      unrelatedRuntimeKey: {
        kept: true,
      },
    });

    expect(parsed.pauseReason?.sampleDigest).toBe(digest);
    expect(parsed.unrelatedRuntimeKey).toEqual({ kept: true });
  });

  it("rejects raw message and non-digest values under pauseReason", () => {
    const parsed = agentRuntimeConfigSchema.safeParse({
      pauseReason: {
        code: "invalid_api_key",
        adapter: "claude_local",
        consecutiveErrorCount: 3,
        firstRunId: "11111111-1111-4111-8111-111111111111",
        lastRunId: "22222222-2222-4222-8222-222222222222",
        sampleDigest: "Authorization: Bearer sk-test",
        createdAt: "2026-05-14T00:00:00.000Z",
        guardVersion: "heartbeat-error-autopause/v1",
        sourceIssueId: "ARI-103",
        rawMessage: "stack trace with sk-test",
      },
    });

    expect(parsed.success).toBe(false);
  });
});
