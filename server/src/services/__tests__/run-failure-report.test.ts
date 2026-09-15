import { randomUUID } from "node:crypto";
import os from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

const mockCaptureRunFailure = vi.hoisted(() => vi.fn());
const mockRedactCurrentUserText = vi.hoisted(() => vi.fn());

vi.mock("../../sentry.js", () => ({
  captureRunFailure: mockCaptureRunFailure,
}));
// Wrap the real function instead of a fake, so tests can assert the actual
// redacted output while still spying on the call. A fake output would hide
// whether the composed redaction in run-failure-report.ts is correct.
vi.mock("../../log-redaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../log-redaction.js")>();
  mockRedactCurrentUserText.mockImplementation(actual.redactCurrentUserText);
  return { ...actual, redactCurrentUserText: mockRedactCurrentUserText };
});

import { reportRunFailure, waitForPendingRunFailureReports } from "../run-failure-report.js";
import { redactSensitiveText, REDACTED_EVENT_VALUE } from "../../redaction.js";
import { redactCurrentUserText } from "../../log-redaction.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reportRunFailure", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-failure-report-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(agentOverrides: Partial<typeof agents.$inferInsert> = {}) {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      ...agentOverrides,
    });
    return { companyId, agentId };
  }

  function buildRun(
    overrides: Partial<typeof heartbeatRuns.$inferSelect> = {},
  ): typeof heartbeatRuns.$inferSelect {
    return {
      id: randomUUID(),
      companyId,
      agentId,
      status: "failed",
      error: "the provider process exited with code 1",
      errorCode: "process_lost",
      nativeIssueId: randomUUID(),
      contextSnapshot: null,
      ...overrides,
    } as unknown as typeof heartbeatRuns.$inferSelect;
  }

  it("captures once for the status failed", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({ status: "failed" });

    await reportRunFailure(db, run);

    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
  });

  it("captures once for the status timed_out", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({ status: "timed_out" });

    await reportRunFailure(db, run);

    expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
    expect(mockCaptureRunFailure).toHaveBeenCalledWith(
      expect.objectContaining({ runStatus: "timed_out" }),
    );
  });

  it("captures nothing for succeeded, cancelled, and interrupted", async () => {
    await seedCompanyAndAgent();
    for (const status of ["succeeded", "cancelled", "interrupted"] as const) {
      const run = buildRun({ status });
      await reportRunFailure(db, run);
    }

    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
  });

  it("sends agents.adapterType from the loaded agent row", async () => {
    await seedCompanyAndAgent({ adapterType: "claude_managed" });
    const run = buildRun({ status: "failed" });

    await reportRunFailure(db, run);

    expect(mockCaptureRunFailure).toHaveBeenCalledWith(
      expect.objectContaining({ agentAdapter: "claude_managed" }),
    );
  });

  it("sends the adapter value unknown when the agent row is absent", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({ status: "failed", agentId: randomUUID() });

    await reportRunFailure(db, run);

    expect(mockCaptureRunFailure).toHaveBeenCalledWith(
      expect.objectContaining({ agentAdapter: "unknown" }),
    );
  });

  it("calls redactCurrentUserText on the error message before it composes the credential redactor", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({ status: "failed", error: "raw message" });

    await reportRunFailure(db, run);

    expect(mockRedactCurrentUserText).toHaveBeenCalledWith("raw message");
  });

  it("removes an Authorization: Bearer credential from the error message", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({
      status: "failed",
      error: "the adapter request failed: Authorization: Bearer live-secret-token-value",
    });

    await reportRunFailure(db, run);

    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorMessage).not.toContain("live-secret-token-value");
    expect(errorMessage).toContain(REDACTED_EVENT_VALUE);
  });

  it("removes an API-key form from the error message", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({
      status: "failed",
      error: `adapter payload: {"apiKey":"json-secret-value"}`,
    });

    await reportRunFailure(db, run);

    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorMessage).not.toContain("json-secret-value");
    expect(errorMessage).toContain(REDACTED_EVENT_VALUE);
  });

  it("removes a JSON Web Token form from the error message", async () => {
    await seedCompanyAndAgent();
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const run = buildRun({ status: "failed", error: `session token: ${jwt}` });

    await reportRunFailure(db, run);

    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorMessage).not.toContain(jwt);
    expect(errorMessage).toContain(REDACTED_EVENT_VALUE);
  });

  it("removes a password value from the error message", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({
      status: "failed",
      error: `login failed: password="hunter2-super-secret"`,
    });

    await reportRunFailure(db, run);

    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorMessage).not.toContain("hunter2-super-secret");
    expect(errorMessage).toContain(REDACTED_EVENT_VALUE);
  });

  it("removes a database connection string from the error message", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({
      status: "failed",
      error: `connect failed: connectionString: "postgres://appuser:s3cr3t-pass@db.internal:5432/paperclip"`,
    });

    await reportRunFailure(db, run);

    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorMessage).not.toContain("s3cr3t-pass");
    expect(errorMessage).toContain(REDACTED_EVENT_VALUE);
  });

  it("still masks the current user's home path in the error message", async () => {
    await seedCompanyAndAgent();
    const homeDir = os.homedir();
    const rawError = `read failed at ${homeDir}/workspace/report.log`;
    const run = buildRun({ status: "failed", error: rawError });

    await reportRunFailure(db, run);

    const expectedErrorMessage = redactSensitiveText(redactCurrentUserText(rawError));
    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorMessage).toBe(expectedErrorMessage);
    expect(errorMessage).not.toContain(homeDir);
  });

  const MAX_ERROR_MESSAGE_LENGTH = 4096;

  it("truncates an error message that is longer than the bound", async () => {
    await seedCompanyAndAgent();
    const longError = "x".repeat(MAX_ERROR_MESSAGE_LENGTH + 500);
    const run = buildRun({ status: "failed", error: longError });

    await reportRunFailure(db, run);

    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorMessage).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
    expect(errorMessage).toBe("x".repeat(MAX_ERROR_MESSAGE_LENGTH));
  });

  it("does not change a short error message", async () => {
    await seedCompanyAndAgent();
    const shortError = "the provider process exited with code 1";
    const run = buildRun({ status: "failed", error: shortError });

    await reportRunFailure(db, run);

    const { errorMessage } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorMessage).toBe(shortError);
  });

  const MAX_ERROR_CODE_LENGTH = 200;

  it("sends a normal error code such as adapter_failed to Sentry unchanged", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({ status: "failed", errorCode: "adapter_failed" });

    await reportRunFailure(db, run);

    expect(mockCaptureRunFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "adapter_failed" }),
    );
  });

  it("redacts an error code that holds a credential form", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({
      status: "failed",
      errorCode: "Authorization: Bearer live-secret-token-value",
    });

    await reportRunFailure(db, run);

    const { errorCode } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorCode).not.toContain("live-secret-token-value");
    expect(errorCode).toContain(REDACTED_EVENT_VALUE);
  });

  it("truncates an error code that is longer than 200 characters", async () => {
    await seedCompanyAndAgent();
    const longErrorCode = "y".repeat(MAX_ERROR_CODE_LENGTH + 50);
    const run = buildRun({ status: "failed", errorCode: longErrorCode });

    await reportRunFailure(db, run);

    const { errorCode } = mockCaptureRunFailure.mock.calls[0][0];
    expect(errorCode).toHaveLength(MAX_ERROR_CODE_LENGTH);
    expect(errorCode).toBe("y".repeat(MAX_ERROR_CODE_LENGTH));
  });

  it("sends errorCode null unchanged when the run holds no error code", async () => {
    await seedCompanyAndAgent();
    const run = buildRun({ status: "failed", errorCode: null });

    await reportRunFailure(db, run);

    expect(mockCaptureRunFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: null }),
    );
  });

  it("reads the task id from nativeIssueId, falling back to contextSnapshot.issueId", async () => {
    await seedCompanyAndAgent();
    const nativeIssueId = randomUUID();
    const runWithNativeIssueId = buildRun({
      status: "failed",
      nativeIssueId,
      contextSnapshot: { issueId: randomUUID() },
    });

    await reportRunFailure(db, runWithNativeIssueId);

    expect(mockCaptureRunFailure).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: nativeIssueId }),
    );

    mockCaptureRunFailure.mockClear();
    const contextIssueId = randomUUID();
    const runWithContextIssueId = buildRun({
      status: "failed",
      nativeIssueId: null,
      contextSnapshot: { issueId: contextIssueId },
    });

    await reportRunFailure(db, runWithContextIssueId);

    expect(mockCaptureRunFailure).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: contextIssueId }),
    );
  });

  it("does not throw when the database read fails", async () => {
    const throwingDb = {
      select: () => {
        throw new Error("connection reset");
      },
    } as unknown as Db;
    const run = buildRun({ status: "failed", agentId: randomUUID() });

    await expect(reportRunFailure(throwingDb, run)).resolves.toBeUndefined();
    expect(mockCaptureRunFailure).not.toHaveBeenCalled();
  });

  describe("waitForPendingRunFailureReports", () => {
    function deferredAgentRows() {
      let resolve!: (rows: Array<{ adapterType: string }>) => void;
      const promise = new Promise<Array<{ adapterType: string }>>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    function fakeDb(agentRowsPromise: Promise<Array<{ adapterType: string }>>): Db {
      return {
        select: () => ({
          from: () => ({
            where: () => agentRowsPromise,
          }),
        }),
      } as unknown as Db;
    }

    it("resolves at once when no report is in flight", async () => {
      await expect(waitForPendingRunFailureReports()).resolves.toBeUndefined();
    });

    it("waits for an unawaited report's database read and Sentry capture before it resolves", async () => {
      const agentRows = deferredAgentRows();
      const run = buildRun({ status: "failed", agentId: randomUUID() });

      // Do not await the report — this models the fire-and-forget
      // `void reportRunFailure(db, run)` call every caller uses.
      void reportRunFailure(fakeDb(agentRows.promise), run);

      const drain = waitForPendingRunFailureReports(1_000);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockCaptureRunFailure).not.toHaveBeenCalled();

      agentRows.resolve([{ adapterType: "claude_managed" }]);
      await drain;

      expect(mockCaptureRunFailure).toHaveBeenCalledTimes(1);
    });

    it("gives up after the bound and does not throw when a report never settles", async () => {
      const run = buildRun({ status: "failed", agentId: randomUUID() });
      void reportRunFailure(fakeDb(new Promise(() => undefined)), run);

      await expect(waitForPendingRunFailureReports(20)).resolves.toBeUndefined();
      expect(mockCaptureRunFailure).not.toHaveBeenCalled();
    });
  });
});
