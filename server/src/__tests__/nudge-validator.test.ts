import { describe, expect, it } from "vitest";
import { nudgeIssueSchema } from "@paperclipai/shared";

describe("nudgeIssueSchema", () => {
  const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const actorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("accepts a well-formed nudge payload", () => {
    const result = nudgeIssueSchema.safeParse({
      reason: "Please respond — blocking my work",
      idempotencyKey: `nudge:${issueId}:${actorId}:2026-05-23`,
    });
    expect(result.success).toBe(true);
  });

  it("rejects idempotencyKey missing the nudge: prefix", () => {
    const result = nudgeIssueSchema.safeParse({
      reason: "ok",
      idempotencyKey: `${issueId}:${actorId}:2026-05-23`,
    });
    expect(result.success).toBe(false);
  });

  it("rejects idempotencyKey with malformed date", () => {
    const result = nudgeIssueSchema.safeParse({
      reason: "ok",
      idempotencyKey: `nudge:${issueId}:${actorId}:2026/05/23`,
    });
    expect(result.success).toBe(false);
  });

  it("rejects idempotencyKey with non-UUID-like ids", () => {
    const result = nudgeIssueSchema.safeParse({
      reason: "ok",
      idempotencyKey: "nudge:foo:bar:2026-05-23",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty reason", () => {
    const result = nudgeIssueSchema.safeParse({
      reason: "",
      idempotencyKey: `nudge:${issueId}:${actorId}:2026-05-23`,
    });
    expect(result.success).toBe(false);
  });

  it("rejects reason longer than 500 chars", () => {
    const result = nudgeIssueSchema.safeParse({
      reason: "x".repeat(501),
      idempotencyKey: `nudge:${issueId}:${actorId}:2026-05-23`,
    });
    expect(result.success).toBe(false);
  });

  it("accepts reason exactly at 500 chars", () => {
    const result = nudgeIssueSchema.safeParse({
      reason: "x".repeat(500),
      idempotencyKey: `nudge:${issueId}:${actorId}:2026-05-23`,
    });
    expect(result.success).toBe(true);
  });
});
