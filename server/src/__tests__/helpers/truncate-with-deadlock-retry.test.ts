import { describe, expect, it, vi } from "vitest";
import { errorHasPostgresCode, truncateTablesWithDeadlockRetry } from "./truncate-with-deadlock-retry.js";

function deadlockError(): Error & { code: string } {
  return Object.assign(new Error("deadlock detected"), { code: "40P01" });
}

function lateCommentForeignKeyError(): Error {
  return new Error(
    'insert or update on table "issue_comments" violates foreign key constraint "issue_comments_issue_id_issues_id_fk"',
  );
}

function unrelatedError(): Error & { code: string } {
  return Object.assign(new Error("relation does not exist"), { code: "42P01" });
}

function fakeDb(execute: ReturnType<typeof vi.fn>) {
  return { execute } as unknown as Parameters<typeof truncateTablesWithDeadlockRetry>[0];
}

describe("truncateTablesWithDeadlockRetry", () => {
  it("retries a deadlock (40P01) and succeeds once the lock clears", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(deadlockError())
      .mockRejectedValueOnce(deadlockError())
      .mockResolvedValueOnce(undefined);

    await truncateTablesWithDeadlockRetry(fakeDb(execute), "TRUNCATE TABLE \"companies\" CASCADE", {
      attempts: 5,
      delayMs: () => 0,
    });

    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("retries the late-comment foreign key violation and succeeds once the dependent row lands", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(lateCommentForeignKeyError())
      .mockResolvedValueOnce(undefined);

    await truncateTablesWithDeadlockRetry(fakeDb(execute), "TRUNCATE TABLE \"issue_comments\" CASCADE", {
      attempts: 5,
      delayMs: () => 0,
    });

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rethrows once attempts are exhausted on a persistent deadlock", async () => {
    const error = deadlockError();
    const execute = vi.fn().mockRejectedValue(error);

    await expect(
      truncateTablesWithDeadlockRetry(fakeDb(execute), "TRUNCATE TABLE \"companies\" CASCADE", {
        attempts: 3,
        delayMs: () => 0,
      }),
    ).rejects.toBe(error);

    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("rethrows immediately on an error that is neither a deadlock nor the late-comment race", async () => {
    const error = unrelatedError();
    const execute = vi.fn().mockRejectedValue(error);

    await expect(
      truncateTablesWithDeadlockRetry(fakeDb(execute), "TRUNCATE TABLE \"companies\" CASCADE", {
        attempts: 5,
        delayMs: () => 0,
      }),
    ).rejects.toBe(error);

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("errorHasPostgresCode", () => {
  it("finds the code on the error itself", () => {
    expect(errorHasPostgresCode(deadlockError(), "40P01")).toBe(true);
  });

  it("finds the code on a wrapped cause", () => {
    const wrapped = new Error("wrapper", { cause: deadlockError() });
    expect(errorHasPostgresCode(wrapped, "40P01")).toBe(true);
  });

  it("returns false when the code never matches", () => {
    expect(errorHasPostgresCode(unrelatedError(), "40P01")).toBe(false);
  });

  it("returns false for a non-object error", () => {
    expect(errorHasPostgresCode("plain string failure", "40P01")).toBe(false);
  });
});
