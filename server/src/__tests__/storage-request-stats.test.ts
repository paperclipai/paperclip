import { describe, expect, it } from "vitest";
import { collectStorageRequestStats, newStorageRequestStats, withStorageRequestStats } from "../storage/request-stats.js";
import { withS3FailureDiagnostics } from "../storage/s3-failure.js";

describe("storage request statistics", () => {
  it("adds each request's SDK attempts and retry delay, on success and on failure", async () => {
    const stats = newStorageRequestStats();
    await collectStorageRequestStats(stats, async () => {
      await withS3FailureDiagnostics("get_object", async () => ({ $metadata: { attempts: 3, totalRetryDelay: 1_250 } }));
      await expect(withS3FailureDiagnostics("put_object", async () => {
        throw Object.assign(new Error("Service Unavailable"), { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503, attempts: 4, totalRetryDelay: 2_000 } });
      })).rejects.toThrow("Service Unavailable");
      // A cleanup request sent outside the diagnostics wrapper still counts.
      await withStorageRequestStats(async () => ({ $metadata: { attempts: 1 } }));
      // No metadata: one attempt, no delay.
      await withS3FailureDiagnostics("head_object", async () => ({}));
    });
    expect(stats).toMatchObject({ requests: 4, attempts: 9, retryDelayMs: 3_250, failedRequests: 1 });
  });

  it("collects nothing outside a collector", async () => {
    const stats = newStorageRequestStats();
    await withS3FailureDiagnostics("get_object", async () => ({ $metadata: { attempts: 2, totalRetryDelay: 10 } }));
    expect(stats.requests).toBe(0);
  });
});
