import { describe, it, expect, vi } from "vitest";
import {
  createVerificationWorker,
  type RunSpecInput,
} from "../services/verification/verification-worker.js";

/**
 * Minimal Drizzle-shaped mock that covers the exact methods verification-worker.ts calls:
 *   - db.select().from(issues).where(...).limit(1).then(...)   → load companyId
 *   - db.insert(verificationRuns).values(...).returning()       → recordAttempt
 *   - db.update(verificationRuns).set(...).where(...).returning() → finalizeAttempt
 */
function makeMockDb(companyId = "co-1") {
  let idCounter = 0;
  const inserted: Array<{ id: string; status: string; attemptNumber: number } & Record<string, unknown>> = [];
  const updated: Array<{ id: string; patch: Record<string, unknown> }> = [];

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            then: (resolver: (rows: unknown[]) => unknown) => resolver([{ companyId }]),
          }),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          idCounter += 1;
          const row = { id: `run-${idCounter}`, ...values, status: "running" };
          inserted.push(row as typeof inserted[number]);
          return [row];
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: (condition: { _runId?: string }) => ({
          returning: async () => {
            // Our mock where() receiver passes { _runId } via a custom shim below
            const runId = condition?._runId ?? inserted[inserted.length - 1]?.id ?? "run-?";
            updated.push({ id: runId, patch });
            return [{ id: runId, ...patch }];
          },
        }),
      }),
    }),
  };

  return { db: db as unknown as Parameters<typeof createVerificationWorker>[0], inserted, updated };
}

const baseInput: RunSpecInput = {
  issueId: "issue-1",
  deliverableType: "url",
  specPath: "skills/acceptance-viracue/tests/DLD-1.url.spec.ts",
  context: "anonymous",
  targetUrl: "https://viracue.ai",
  targetSha: "sha-1",
};

describe("createVerificationWorker", () => {
  it("stops retrying after first pass and records one verification_runs row", async () => {
    const { db, inserted } = makeMockDb();
    const runUrl = vi.fn().mockResolvedValueOnce({
      status: "passed",
      traceDir: "/tmp/trace",
      durationMs: 1000,
      deployedSha: "sha-1",
    });
    const uploader = { upload: vi.fn().mockResolvedValue({ assetId: "asset-1", byteSize: 1234 }) };
    const worker = createVerificationWorker(db, {} as never, {
      retryBudget: 3,
      retryDelayMs: 0,
      runUrl,
      uploader,
      sleep: async () => undefined,
    });
    const result = await worker.runSpec(baseInput);
    expect(result.status).toBe("passed");
    expect(runUrl).toHaveBeenCalledTimes(1);
    expect(uploader.upload).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(1);
  });

  it("retries up to retryBudget on repeated failure", async () => {
    const { db } = makeMockDb();
    const runUrl = vi.fn().mockResolvedValue({
      status: "failed",
      traceDir: "/tmp/trace",
      failureSummary: "x",
      durationMs: 1000,
      deployedSha: "sha-1",
      rawStdout: "",
    });
    const uploader = { upload: vi.fn().mockResolvedValue({ assetId: "asset-1", byteSize: 10 }) };
    const worker = createVerificationWorker(db, {} as never, {
      retryBudget: 3,
      retryDelayMs: 0,
      runUrl,
      uploader,
      sleep: async () => undefined,
    });
    const result = await worker.runSpec(baseInput);
    expect(result.status).toBe("failed");
    expect(runUrl).toHaveBeenCalledTimes(3);
    if (result.status === "failed") {
      expect(result.attempts).toBe(3);
    }
  });

  it("does not count unavailable against the retry budget (up to safety ceiling)", async () => {
    const { db } = makeMockDb();
    const runUrl = vi.fn().mockResolvedValue({
      status: "unavailable",
      unavailableReason: "vps down",
    });
    const worker = createVerificationWorker(db, {} as never, {
      retryBudget: 3,
      retryDelayMs: 0,
      runUrl,
      uploader: { upload: vi.fn() },
      sleep: async () => undefined,
    });
    const result = await worker.runSpec(baseInput);
    expect(result.status).toBe("unavailable");
    // The safety ceiling is retryBudget * 2, so 6 calls before we bail out on persistent unavailable
    expect(runUrl.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(runUrl.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("returns passed even if a failed attempt precedes a passing one", async () => {
    const { db } = makeMockDb();
    const runUrl = vi
      .fn()
      .mockResolvedValueOnce({
        status: "failed",
        traceDir: "/tmp/trace",
        failureSummary: "flake",
        durationMs: 500,
        deployedSha: "sha-1",
        rawStdout: "",
      })
      .mockResolvedValueOnce({
        status: "passed",
        traceDir: "/tmp/trace2",
        durationMs: 800,
        deployedSha: "sha-1",
      });
    const uploader = { upload: vi.fn().mockResolvedValue({ assetId: "a", byteSize: 10 }) };
    const worker = createVerificationWorker(db, {} as never, {
      retryBudget: 3,
      retryDelayMs: 0,
      runUrl,
      uploader,
      sleep: async () => undefined,
    });
    const result = await worker.runSpec(baseInput);
    expect(result.status).toBe("passed");
    expect(runUrl).toHaveBeenCalledTimes(2);
    expect(uploader.upload).toHaveBeenCalledTimes(2); // trace uploaded for both attempts
  });

  it("returns unavailable when deliverable_type is not yet supported", async () => {
    const { db } = makeMockDb();
    const runUrl = vi.fn();
    const worker = createVerificationWorker(db, {} as never, {
      retryBudget: 1,
      retryDelayMs: 0,
      runUrl,
      uploader: { upload: vi.fn() },
      sleep: async () => undefined,
    });
    const result = await worker.runSpec({ ...baseInput, deliverableType: "api" });
    expect(result.status).toBe("unavailable");
    expect(runUrl).not.toHaveBeenCalled();
  });
});
