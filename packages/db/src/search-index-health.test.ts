import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRIGRAM_SEARCH_INDEXES,
  __resetSearchDegradationForTests,
  enterDegradedSearchMode,
  getSearchDegradation,
  getSearchHealthReport,
  isTrigramIndexUnavailableError,
  probeTrigramExtension,
  withSearchIndexFallback,
} from "./search-index-health.js";

// The exact error string observed in incident TON-2143.
const TON_2143_MESSAGE = 'could not access file "pg_trgm": No such file or directory';

function fakeDb(execute: (query?: unknown) => Promise<unknown> = async () => []) {
  return { execute: vi.fn(execute) } as { execute: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  __resetSearchDegradationForTests();
});

describe("isTrigramIndexUnavailableError", () => {
  it("matches the TON-2143 pg_trgm load failure", () => {
    expect(isTrigramIndexUnavailableError(new Error(TON_2143_MESSAGE))).toBe(true);
  });

  it("matches a postgres-js style error object", () => {
    expect(
      isTrigramIndexUnavailableError({ message: TON_2143_MESSAGE, severity: "ERROR" }),
    ).toBe(true);
  });

  it("matches when the failure is wrapped in a cause chain", () => {
    const wrapped = new Error("Insert failed", { cause: new Error(TON_2143_MESSAGE) });
    expect(isTrigramIndexUnavailableError(wrapped)).toBe(true);
  });

  it("matches trigram operator-class failures", () => {
    expect(
      isTrigramIndexUnavailableError(new Error("function gin_extract_value_trgm does not exist")),
    ).toBe(true);
  });

  it("does NOT match unrelated database errors (real bugs still surface)", () => {
    expect(
      isTrigramIndexUnavailableError(
        new Error('duplicate key value violates unique constraint "issues_pkey"'),
      ),
    ).toBe(false);
    expect(isTrigramIndexUnavailableError(new Error("null value in column violates not-null"))).toBe(
      false,
    );
    expect(isTrigramIndexUnavailableError(null)).toBe(false);
  });
});

describe("withSearchIndexFallback", () => {
  it("returns the result and stays healthy when the write succeeds", async () => {
    const db = fakeDb();
    const result = await withSearchIndexFallback(db, async () => "ok", {
      operationName: "test.write",
    });
    expect(result).toBe("ok");
    expect(getSearchDegradation().degraded).toBe(false);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("degrades search and retries when trigram maintenance fails, then completes the write", async () => {
    const db = fakeDb();
    let attempts = 0;
    const result = await withSearchIndexFallback(
      db,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error(TON_2143_MESSAGE);
        return "written";
      },
      { operationName: "issue_comment.insert", now: () => "2026-06-04T00:00:00.000Z" },
    );

    expect(result).toBe("written");
    expect(attempts).toBe(2);

    const degradation = getSearchDegradation();
    expect(degradation.degraded).toBe(true);
    expect(degradation.reason).toBe("trigram_unavailable:issue_comment.insert");
    expect(degradation.since).toBe("2026-06-04T00:00:00.000Z");
    expect(degradation.droppedIndexes).toEqual(TRIGRAM_SEARCH_INDEXES.map((i) => i.index));
    // One DROP INDEX per trigram index.
    expect(db.execute).toHaveBeenCalledTimes(TRIGRAM_SEARCH_INDEXES.length);
  });

  it("rethrows non-trigram errors without degrading search", async () => {
    const db = fakeDb();
    await expect(
      withSearchIndexFallback(db, async () => {
        throw new Error("duplicate key value violates unique constraint");
      }, { operationName: "test.write" }),
    ).rejects.toThrow(/duplicate key/);
    expect(getSearchDegradation().degraded).toBe(false);
    expect(db.execute).not.toHaveBeenCalled();
  });

  // PR #7482 review (Greptile P1): if every DROP INDEX fails (e.g. lock_timeout), the indexes
  // are still live, so the fallback must surface the original error rather than falsely
  // claiming degraded and looping.
  it("rethrows the original error and does NOT degrade when every DROP INDEX fails", async () => {
    const db = fakeDb(async () => {
      throw new Error("canceling statement due to lock_timeout");
    });
    const trigramError = new Error(TON_2143_MESSAGE);
    await expect(
      withSearchIndexFallback(db, async () => {
        throw trigramError;
      }, { operationName: "issue_comment.insert" }),
    ).rejects.toBe(trigramError);

    expect(getSearchDegradation().degraded).toBe(false);
    // One DROP attempt per index (all failed), but no retry of the operation.
    expect(db.execute).toHaveBeenCalledTimes(TRIGRAM_SEARCH_INDEXES.length);
  });
});

describe("enterDegradedSearchMode", () => {
  it("is idempotent — drops indexes only once across repeated calls", async () => {
    const db = fakeDb();
    await enterDegradedSearchMode(db, { reason: "first", now: "t0" });
    await enterDegradedSearchMode(db, { reason: "second", now: "t1" });

    expect(db.execute).toHaveBeenCalledTimes(TRIGRAM_SEARCH_INDEXES.length);
    const degradation = getSearchDegradation();
    expect(degradation.reason).toBe("first");
    expect(degradation.since).toBe("t0");
  });

  it("returns degraded=false and records nothing when all drops fail", async () => {
    const db = fakeDb(async () => {
      throw new Error("lock_timeout");
    });
    const result = await enterDegradedSearchMode(db, { reason: "all-fail", now: "t0" });
    expect(result.degraded).toBe(false);
    expect(result.droppedIndexes).toEqual([]);
    expect(getSearchDegradation().degraded).toBe(false);
  });

  it("degrades on partial success (at least one index dropped)", async () => {
    let call = 0;
    const db = fakeDb(async () => {
      call += 1;
      if (call === 1) throw new Error("lock_timeout"); // first index fails
      return [];
    });
    const result = await enterDegradedSearchMode(db, { reason: "partial", now: "t1" });
    expect(result.degraded).toBe(true);
    expect(result.droppedIndexes).toEqual(TRIGRAM_SEARCH_INDEXES.slice(1).map((i) => i.index));
  });
});

describe("probeTrigramExtension (doctor check)", () => {
  it("reports loadable when catalog has it and show_trgm succeeds", async () => {
    const db = fakeDb(async (query) => {
      const text = String(query);
      if (text.includes("pg_extension")) return [{ present: 1 }];
      return [{ probe: ["he", "hea"] }];
    });
    const health = await probeTrigramExtension(db);
    expect(health).toMatchObject({
      extension: "pg_trgm",
      installedInCatalog: true,
      loadableAtRuntime: true,
    });
  });

  it("flags installed-but-not-loadable (the TON-2143 state)", async () => {
    let call = 0;
    const db = fakeDb(async () => {
      call += 1;
      if (call === 1) return [{ present: 1 }]; // catalog lookup
      throw new Error(TON_2143_MESSAGE); // show_trgm forces the library load and fails
    });
    const health = await probeTrigramExtension(db);
    expect(health.installedInCatalog).toBe(true);
    expect(health.loadableAtRuntime).toBe(false);
    expect(health.error).toContain("pg_trgm");
  });

  it("reports not-installed when absent from the catalog", async () => {
    const db = fakeDb(async () => []);
    const health = await probeTrigramExtension(db);
    expect(health.installedInCatalog).toBe(false);
    expect(health.loadableAtRuntime).toBe(false);
  });
});

describe("getSearchHealthReport", () => {
  it("is degraded when the extension is installed but not loadable", async () => {
    let call = 0;
    const db = fakeDb(async () => {
      call += 1;
      if (call === 1) return [{ present: 1 }];
      throw new Error(TON_2143_MESSAGE);
    });
    const report = await getSearchHealthReport(db);
    expect(report.status).toBe("degraded");
    expect(report.extensions[0]?.loadableAtRuntime).toBe(false);
  });

  it("is ok when the extension loads and search has not been degraded", async () => {
    const db = fakeDb(async (query) => {
      if (String(query).includes("pg_extension")) return [{ present: 1 }];
      return [{ probe: [] }];
    });
    const report = await getSearchHealthReport(db);
    expect(report.status).toBe("ok");
  });
});
