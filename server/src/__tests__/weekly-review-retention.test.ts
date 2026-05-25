import { describe, expect, it } from "vitest";
import { weeklyReviewEvents } from "@paperclipai/db";
import {
  canPurgeExpiredWeeklyReviewTable,
  computeDebugEventExpiresAt,
  computeProbeExpiresAt,
  isAuditCriticalWeeklyReviewTable,
  isExpiredRetentionTimestamp,
  redactWeeklyReviewDebugMetadata,
  redactWeeklyReviewDiagnosticString,
  shouldPurgeAdapterReadinessProbe,
  shouldPurgeWeeklyReviewDebugEvent,
} from "../services/weekly-review/retention.js";
import { weeklyReviewEventService } from "../services/weekly-review/events.js";

describe("weekly review retention", () => {
  it("expires failed debug metadata after 30 days", () => {
    const now = new Date("2026-05-21T12:00:00.000Z");
    expect(computeDebugEventExpiresAt(now).toISOString()).toBe("2026-06-20T12:00:00.000Z");
  });

  it("expires readiness probe records after 90 days", () => {
    const now = new Date("2026-05-21T12:00:00.000Z");
    expect(computeProbeExpiresAt(now).toISOString()).toBe("2026-08-19T12:00:00.000Z");
  });

  it("never purges audit-critical weekly review records", () => {
    expect(isAuditCriticalWeeklyReviewTable("weekly_reviews")).toBe(true);
    expect(isAuditCriticalWeeklyReviewTable("weekly_review_versions")).toBe(true);
    expect(isAuditCriticalWeeklyReviewTable("weekly_review_findings")).toBe(true);
    expect(isAuditCriticalWeeklyReviewTable("weekly_review_citations")).toBe(true);
    expect(isAuditCriticalWeeklyReviewTable("weekly_review_recommendations")).toBe(true);
    expect(isAuditCriticalWeeklyReviewTable("weekly_review_actions")).toBe(true);
    expect(isAuditCriticalWeeklyReviewTable("activity_log")).toBe(true);
    expect(isAuditCriticalWeeklyReviewTable("weekly_review_events")).toBe(false);
    expect(isAuditCriticalWeeklyReviewTable("adapter_readiness_probes")).toBe(false);
  });

  it("limits expired-record purge eligibility to debug events and readiness probes", () => {
    expect(canPurgeExpiredWeeklyReviewTable("weekly_review_events")).toBe(true);
    expect(canPurgeExpiredWeeklyReviewTable("adapter_readiness_probes")).toBe(true);
    expect(canPurgeExpiredWeeklyReviewTable("weekly_reviews")).toBe(false);
    expect(canPurgeExpiredWeeklyReviewTable("weekly_review_versions")).toBe(false);
    expect(canPurgeExpiredWeeklyReviewTable("weekly_review_citations")).toBe(false);
    expect(canPurgeExpiredWeeklyReviewTable("weekly_review_actions")).toBe(false);
    expect(canPurgeExpiredWeeklyReviewTable("activity_log")).toBe(false);
    expect(canPurgeExpiredWeeklyReviewTable("unknown_table")).toBe(false);
  });

  it("treats null and future expiration timestamps as retained", () => {
    const now = new Date("2026-05-21T12:00:00.000Z");

    expect(isExpiredRetentionTimestamp(null, now)).toBe(false);
    expect(isExpiredRetentionTimestamp(undefined, now)).toBe(false);
    expect(isExpiredRetentionTimestamp(new Date("2026-05-21T12:00:00.001Z"), now)).toBe(false);
    expect(isExpiredRetentionTimestamp(new Date("2026-05-21T12:00:00.000Z"), now)).toBe(true);
    expect(isExpiredRetentionTimestamp(new Date("2026-05-21T11:59:59.999Z"), now)).toBe(true);
  });

  it("purges only expired debug events", () => {
    const now = new Date("2026-05-21T12:00:00.000Z");

    expect(shouldPurgeWeeklyReviewDebugEvent({ expiresAt: null, now })).toBe(false);
    expect(shouldPurgeWeeklyReviewDebugEvent({ expiresAt: new Date("2026-05-21T12:00:00.001Z"), now })).toBe(false);
    expect(shouldPurgeWeeklyReviewDebugEvent({ expiresAt: new Date("2026-05-21T12:00:00.000Z"), now })).toBe(true);
    expect(shouldPurgeWeeklyReviewDebugEvent({ expiresAt: new Date("2026-05-21T11:59:59.999Z"), now })).toBe(true);
  });

  it("retains the latest 50 readiness probes per agent even after expiration", () => {
    const now = new Date("2026-05-21T12:00:00.000Z");
    const expiredAt = new Date("2026-05-21T12:00:00.000Z");

    expect(
      shouldPurgeAdapterReadinessProbe({
        expiresAt: expiredAt,
        newerProbeCountForAgent: 49,
        now,
      }),
    ).toBe(false);
    expect(
      shouldPurgeAdapterReadinessProbe({
        expiresAt: expiredAt,
        newerProbeCountForAgent: 50,
        now,
      }),
    ).toBe(true);
  });

  it("does not purge unexpired or indefinite readiness probes even outside the latest 50", () => {
    const now = new Date("2026-05-21T12:00:00.000Z");

    expect(
      shouldPurgeAdapterReadinessProbe({
        expiresAt: null,
        newerProbeCountForAgent: 500,
        now,
      }),
    ).toBe(false);
    expect(
      shouldPurgeAdapterReadinessProbe({
        expiresAt: new Date("2026-05-21T12:00:00.001Z"),
        newerProbeCountForAgent: 500,
        now,
      }),
    ).toBe(false);
  });

  it("redacts dangerous debug metadata fields", () => {
    expect(
      redactWeeklyReviewDebugMetadata({
        prompt: "secret prompt",
        transcript: "raw transcript",
        env: { OPENAI_API_KEY: "sk-test" },
        signedUrl: "https://example.test/signed",
        validationErrors: ["missing citation"],
        ruleNames: ["citation.required"],
      }),
    ).toEqual({
      validationErrors: ["missing citation"],
      ruleNames: ["citation.required"],
    });
  });

  it("sanitizes dangerous values inside allowed debug metadata fields", () => {
    const redacted = redactWeeklyReviewDebugMetadata({
      validationErrors: [
        "missing citation",
        "full transcript: user asked for a weekly review and included customer content",
      ],
      ruleNames: ["citation.required"],
      entityIds: [
        "issue-123",
        "https://storage.example.test/work-products/report.md?token=secret-token",
      ],
      counts: {
        issues: 2,
        prompt: "raw prompt hidden in allowed object",
        log: "OPENAI_API_KEY=sk-test-token",
      },
      errorCode: "citation_missing",
      failureReason:
        "failed while reading /Users/example/server/work/company-1/report.md with api_key=secret",
    });

    expect(redacted).toEqual({
      validationErrors: ["missing citation", "[redacted]"],
      ruleNames: ["citation.required"],
      entityIds: ["issue-123", "[redacted]"],
      counts: {
        issues: 2,
      },
      errorCode: "citation_missing",
      failureReason: "[redacted]",
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("https://storage.example.test");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("raw prompt");
    expect(serialized).not.toContain("/server/work/");
    expect(serialized).not.toContain("customer content");
  });

  it("redacts credential, connection, URL, and work-product variants inside allowed fields", () => {
    const redacted = redactWeeklyReviewDebugMetadata({
      validationErrors: [
        "safe issue reference",
        "postgres://user:password@db.example.test/paperclip",
        "git@github.com:private/repo.git",
        "s3://private-bucket/work-product.json",
        "file:///Users/example/server/work/report.md",
      ],
      counts: {
        safeCount: 3,
        password: "hunter2",
        authorization: "Bearer secret-token-value",
        authToken: "secret-token-value",
        databaseUrl: "postgres://user:password@db.example.test/paperclip",
        privateKey: "-----BEGIN PRIVATE KEY-----",
        sshPrivateKey: "ssh-private-key",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        signed_url: "https://example.test/blob?token=secret",
      },
      entityIds: ["issue-123", "ssh://git@example.test/private/repo"],
    });

    expect(redacted).toEqual({
      validationErrors: [
        "safe issue reference",
        "[redacted]",
        "[redacted]",
        "[redacted]",
        "[redacted]",
      ],
      counts: {
        safeCount: 3,
      },
      entityIds: ["issue-123", "[redacted]"],
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("AKIA");
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain("s3://");
    expect(serialized).not.toContain("file://");
    expect(serialized).not.toContain("git@github.com");
  });

  it("bounds retained allowed string and array values", () => {
    const redacted = redactWeeklyReviewDebugMetadata({
      validationErrors: Array.from({ length: 20 }, (_, index) => `safe validation ${index}`),
      failureReason: "x".repeat(500),
    });

    expect(redacted?.validationErrors).toHaveLength(10);
    expect(redacted?.failureReason).toBe(`${"x".repeat(157)}...`);
  });

  it("redacts standalone diagnostic strings before event persistence", () => {
    expect(redactWeeklyReviewDiagnosticString("missing citation")).toBe("missing citation");
    expect(
      redactWeeklyReviewDiagnosticString("signed URL leaked: https://example.test/report?token=secret"),
    ).toBe("[redacted]");
    expect(redactWeeklyReviewDiagnosticString("raw transcript included customer content")).toBe("[redacted]");
  });

  it("returns null when no bounded debug metadata remains after redaction", () => {
    expect(
      redactWeeklyReviewDebugMetadata({
        prompt: "secret prompt",
        transcript: "raw transcript",
      }),
    ).toBeNull();
  });
});

describe("weekly review event service", () => {
  function createInsertRecorder() {
    const tables: unknown[] = [];
    const calls: unknown[] = [];
    const db = {
      insert: (table: unknown) => ({
        values: (value: unknown) => {
          tables.push(table);
          calls.push(value);
          return {
            returning: async () => [{ id: "event-1", ...(value as Record<string, unknown>) }],
          };
        },
      }),
    };

    return { db, calls, tables };
  }

  it("records failed events with redacted debug metadata and expiration", async () => {
    const { db, calls, tables } = createInsertRecorder();

    const row = await weeklyReviewEventService(db as never).record({
      companyId: "company-1",
      eventType: "generation_failed",
      status: "completed",
      debugMetadata: {
        prompt: "secret prompt",
        validationErrors: ["missing citation"],
        errorCode: "citation_missing",
      },
    });

    const inserted = calls[0] as Record<string, unknown>;
    expect(tables[0]).toBe(weeklyReviewEvents);
    expect(inserted.status).toBe("failed");
    expect(inserted.debugMetadataJson).toEqual({
      validationErrors: ["missing citation"],
      errorCode: "citation_missing",
    });
    expect(inserted.expiresAt).toBeInstanceOf(Date);
    expect(row.debugMetadataJson).toEqual(inserted.debugMetadataJson);
  });

  it("records failed status events with redacted debug metadata and expiration", async () => {
    const { db, calls, tables } = createInsertRecorder();

    await weeklyReviewEventService(db as never).record({
      companyId: "company-1",
      eventType: "version_ready",
      status: "failed",
      failureReason: "signed URL leaked: https://example.test/report?token=secret",
      debugMetadata: {
        validationErrors: ["missing citation"],
        failureReason: "signed URL leaked: https://example.test/report?token=secret",
      },
    });

    const inserted = calls[0] as Record<string, unknown>;
    expect(tables[0]).toBe(weeklyReviewEvents);
    expect(inserted.status).toBe("failed");
    expect(inserted.debugMetadataJson).toEqual({
      validationErrors: ["missing citation"],
      failureReason: "[redacted]",
    });
    expect(inserted.failureReason).toBe("[redacted]");
    expect(inserted.expiresAt).toBeInstanceOf(Date);
  });

  it("does not persist debug metadata or expiration for non-failure events", async () => {
    const { db, calls } = createInsertRecorder();

    await weeklyReviewEventService(db as never).record({
      companyId: "company-1",
      eventType: "version_ready",
      status: "completed",
      failureReason: "not a failure",
      debugMetadata: {
        validationErrors: ["should not persist"],
      },
    });

    const inserted = calls[0] as Record<string, unknown>;
    expect(inserted.debugMetadataJson).toBeNull();
    expect(inserted.failureReason).toBeNull();
    expect(inserted.expiresAt).toBeNull();
  });
});
