import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePostgresDatabase } from "./client.js";

/** Boilerplate for a mock sql object matching what `createUtilitySql` returns. */
function sqlThatRejects(err: Error) {
  const fn = vi.fn().mockRejectedValue(err);
  return Object.assign(fn, {
    unsafe: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  });
}

function sqlThatResolves(value: unknown[]) {
  const fn = vi.fn().mockResolvedValue(value);
  return Object.assign(fn, {
    unsafe: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  });
}

function sqlThatCreatesAndResolves() {
  const fn = vi.fn().mockResolvedValue([]);
  const unsafe = vi.fn().mockResolvedValue(undefined);
  return Object.assign(fn, {
    unsafe,
    end: vi.fn().mockResolvedValue(undefined),
  });
}

const makeShutdownError = () =>
  Object.assign(new Error("database system is shutting down"), {
    code: "57P03",
  });

const makeAuthError = () =>
  Object.assign(new Error("password authentication failed"), {
    code: "28P01",
  });

// ─── Mocks ─────────────────────────────────────────────────

const { mockDelay, mockPostgres } = vi.hoisted(() => {
  const delay = vi.fn().mockResolvedValue(undefined);
  const pg = vi.fn();
  return { mockDelay: delay, mockPostgres: pg };
});

vi.mock("postgres", () => ({ default: mockPostgres }));
vi.mock("node:timers/promises", () => ({ setTimeout: mockDelay }));

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────

describe("ensurePostgresDatabase", () => {
  it("retries with exponential backoff on 57P03, then returns 'exists'", async () => {
    mockPostgres.mockReturnValue(sqlThatResolves([{ one: 1 }]));
    mockPostgres
      .mockReturnValueOnce(sqlThatRejects(makeShutdownError()))
      .mockReturnValueOnce(sqlThatRejects(makeShutdownError()));

    const result = await ensurePostgresDatabase(
      "postgres://paperclip:paperclip@127.0.0.1:5432/postgres",
      "paperclip",
    );

    expect(result).toBe("exists");
    // 3 attempts (2 failures + 1 success)
    expect(mockPostgres).toHaveBeenCalledTimes(3);
    // Backoff: 1s then 2s
    expect(mockDelay).toHaveBeenCalledTimes(2);
    expect(mockDelay).toHaveBeenNthCalledWith(1, 1000);
    expect(mockDelay).toHaveBeenNthCalledWith(2, 2000);
  });

  it("retries on 57P03 then returns 'created' when database does not exist yet", async () => {
    mockPostgres.mockReturnValue(sqlThatCreatesAndResolves());
    mockPostgres.mockReturnValueOnce(sqlThatRejects(makeShutdownError()));

    const result = await ensurePostgresDatabase(
      "postgres://paperclip:paperclip@127.0.0.1:5432/postgres",
      "paperclip",
    );

    expect(result).toBe("created");
    expect(mockPostgres).toHaveBeenCalledTimes(2);
    expect(mockDelay).toHaveBeenCalledOnce();
    expect(mockDelay).toHaveBeenCalledWith(1000);
  });

  it("propagates non-57P03 errors immediately (no retry)", async () => {
    mockPostgres.mockReturnValue(sqlThatRejects(makeAuthError()));

    await expect(
      ensurePostgresDatabase(
        "postgres://paperclip:paperclip@127.0.0.1:5432/postgres",
        "paperclip",
      ),
    ).rejects.toThrow("password authentication failed");

    expect(mockPostgres).toHaveBeenCalledTimes(1);
    expect(mockDelay).not.toHaveBeenCalled();
  });

  it("throws the last 57P03 error after exhausting all backoff retries", async () => {
    // 8 backoff delays → 9 total attempts (attempt 0..7 get retried, attempt 8 throws)
    mockPostgres.mockReturnValue(sqlThatRejects(makeShutdownError()));

    await expect(
      ensurePostgresDatabase(
        "postgres://paperclip:paperclip@127.0.0.1:5432/postgres",
        "paperclip",
      ),
    ).rejects.toThrow("database system is shutting down");

    // 9 calls = initial + 8 retries
    expect(mockPostgres).toHaveBeenCalledTimes(9);
    // 8 delays: 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s
    expect(mockDelay).toHaveBeenCalledTimes(8);
    expect(mockDelay).toHaveBeenNthCalledWith(1, 1000);
    expect(mockDelay).toHaveBeenNthCalledWith(2, 2000);
    expect(mockDelay).toHaveBeenNthCalledWith(3, 4000);
    expect(mockDelay).toHaveBeenNthCalledWith(4, 8000);
    expect(mockDelay).toHaveBeenNthCalledWith(5, 16_000);
    expect(mockDelay).toHaveBeenNthCalledWith(6, 30_000);
    expect(mockDelay).toHaveBeenNthCalledWith(7, 30_000);
    expect(mockDelay).toHaveBeenNthCalledWith(8, 30_000);
  });

  it("always calls sql.end() on every attempt (even on failure)", async () => {
    const createdSqlMocks: Array<ReturnType<typeof sqlThatResolves>> = [];
    mockPostgres.mockImplementation(() => {
      const sql = sqlThatRejects(makeShutdownError());
      createdSqlMocks.push(sql);
      return sql;
    });

    await expect(
      ensurePostgresDatabase(
        "postgres://paperclip:paperclip@127.0.0.1:5432/postgres",
        "paperclip",
      ),
    ).rejects.toThrow("database system is shutting down");

    expect(mockPostgres).toHaveBeenCalledTimes(9);
    expect(createdSqlMocks).toHaveLength(9);
    for (const sql of createdSqlMocks) {
      expect(sql.end).toHaveBeenCalled();
    }
  });

  it("rejects unsafe database names without connecting", async () => {
    await expect(
      ensurePostgresDatabase(
        "postgres://paperclip:paperclip@127.0.0.1:5432/postgres",
        "; DROP TABLE users",
      ),
    ).rejects.toThrow("Unsafe database name");

    expect(mockPostgres).not.toHaveBeenCalled();
    expect(mockDelay).not.toHaveBeenCalled();
  });

  it("succeeds on first try when no shutdown race exists", async () => {
    mockPostgres.mockReturnValue(sqlThatResolves([{ one: 1 }]));

    const result = await ensurePostgresDatabase(
      "postgres://paperclip:paperclip@127.0.0.1:5432/postgres",
      "paperclip",
    );

    expect(result).toBe("exists");
    expect(mockPostgres).toHaveBeenCalledTimes(1);
    expect(mockDelay).not.toHaveBeenCalled();
  });
});