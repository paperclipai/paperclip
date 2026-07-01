import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_RUN_DISPATCHER_OMITTED_COLUMNS,
  heartbeatRunDispatcherColumns,
} from "../services/heartbeat.ts";

// Regression for BTCAAAAA-37843: the hot dispatcher / claim-loop SELECT on
// `heartbeat_runs` must not project TOAST-stored columns. Detoasting them on
// every heartbeat across many concurrent backends produced the 16-17 active-
// backend thundering herd flagged in BTCAAAAA-37812.
describe("heartbeat dispatcher projection (BTCAAAAA-37843)", () => {
  it("omits TOAST-stored columns from the dispatcher projection", () => {
    const projectedKeys = new Set(Object.keys(heartbeatRunDispatcherColumns));
    const omittedCamelCase = [
      "usageJson",
      "logStore",
      "logRef",
      "logBytes",
      "logSha256",
      "logCompressed",
    ];
    for (const key of omittedCamelCase) {
      expect(projectedKeys.has(key)).toBe(false);
    }
  });

  it("documents the omitted physical column names so reviewers can audit query logs", () => {
    expect([...HEARTBEAT_RUN_DISPATCHER_OMITTED_COLUMNS].sort()).toEqual([
      "log_bytes",
      "log_compressed",
      "log_ref",
      "log_sha256",
      "log_store",
      "usage_json",
    ]);
  });

  it("keeps the columns the dispatcher and claim loop actually consume", () => {
    const projectedKeys = new Set(Object.keys(heartbeatRunDispatcherColumns));
    const required = [
      "id",
      "companyId",
      "agentId",
      "status",
      "startedAt",
      "createdAt",
      "wakeupRequestId",
      "contextSnapshot",
      "scheduledRetryReason",
      // resultJson is preserved because cancel paths merge it into the
      // cancelled run's stop-reason payload; only the 6 TOAST columns above
      // are dropped.
      "resultJson",
    ];
    for (const key of required) {
      expect(projectedKeys.has(key)).toBe(true);
    }
  });
});
