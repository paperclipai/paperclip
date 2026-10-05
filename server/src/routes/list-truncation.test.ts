import { describe, expect, it } from "vitest";
import {
  LIST_RESULT_COUNT_HEADER,
  LIST_RESULT_LIMIT_HEADER,
  LIST_RESULT_OFFSET_HEADER,
  LIST_RESULT_TRUNCATED_HEADER,
  LIST_TOTAL_COUNT_HEADER,
  parseListOffsetParam,
  probeLimit,
  setListPaginationHeaders,
  splitProbePage,
} from "./list-truncation.js";

function fakeResponse() {
  const headers = new Map<string, string>();
  return {
    headers,
    res: {
      setHeader: (name: string, value: string) => headers.set(name, value),
    } as any,
  };
}

describe("splitProbePage", () => {
  it("reports truncation when the probe row came back", () => {
    const page = splitProbePage([1, 2, 3, 4], 3);
    expect(page.truncated).toBe(true);
    expect(page.rows).toEqual([1, 2, 3]);
  });

  // The control: without this case a hard-coded `truncated: true` would pass
  // the test above. A corpus that ends exactly at the limit is the case the
  // silent-clamp bug could not distinguish.
  it("reports no truncation when the corpus ends exactly at the limit", () => {
    const page = splitProbePage([1, 2, 3], 3);
    expect(page.truncated).toBe(false);
    expect(page.rows).toEqual([1, 2, 3]);
  });

  it("reports no truncation for a short page", () => {
    const page = splitProbePage([1], 3);
    expect(page.truncated).toBe(false);
    expect(page.rows).toEqual([1]);
  });

  it("reports no truncation for an empty page", () => {
    const page = splitProbePage([], 3);
    expect(page.truncated).toBe(false);
    expect(page.rows).toEqual([]);
  });

  it("asks the data layer for exactly one row past the page", () => {
    expect(probeLimit(1000)).toBe(1001);
    expect(probeLimit(1)).toBe(2);
  });
});

describe("parseListOffsetParam", () => {
  it("accepts an absent parameter and a usable offset", () => {
    expect(parseListOffsetParam(undefined)).toBeUndefined();
    expect(parseListOffsetParam("0")).toBe(0);
    expect(parseListOffsetParam("1000")).toBe(1000);
    expect(parseListOffsetParam(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("rejects an offset the server could not apply", () => {
    // A digit-only test alone passes both of these. The first is finite but
    // beyond what Postgres takes as an OFFSET, so it failed the request; the
    // second parses to Infinity, which floors to 0 — the caller would get page
    // one while the response reported the offset it asked for.
    expect(parseListOffsetParam("1".repeat(20))).toBeNull();
    expect(parseListOffsetParam("9".repeat(400))).toBeNull();
  });

  it("rejects a malformed or repeated offset", () => {
    for (const raw of ["abc", "-1", "1.5", "", " 1", "1e3", ["0", "5"], 7]) {
      expect(parseListOffsetParam(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe("setListPaginationHeaders", () => {
  it("publishes the applied limit, offset, count and truncation flag", () => {
    const { headers, res } = fakeResponse();
    setListPaginationHeaders(res, {
      count: 1000,
      limit: 1000,
      offset: 0,
      truncated: true,
    });
    expect(headers.get(LIST_RESULT_COUNT_HEADER)).toBe("1000");
    expect(headers.get(LIST_RESULT_LIMIT_HEADER)).toBe("1000");
    expect(headers.get(LIST_RESULT_OFFSET_HEADER)).toBe("0");
    expect(headers.get(LIST_RESULT_TRUNCATED_HEADER)).toBe("true");
  });

  it("writes truncated=false rather than omitting the header", () => {
    // A completeness proof reads this header directly, so an absent value must
    // never be the way "complete" is expressed.
    const { headers, res } = fakeResponse();
    setListPaginationHeaders(res, {
      count: 3,
      limit: 500,
      offset: 0,
      truncated: false,
    });
    expect(headers.get(LIST_RESULT_TRUNCATED_HEADER)).toBe("false");
  });

  it("writes unknown when the route cannot answer, never false", () => {
    // `false` is the only completeness claim, so a route that cannot measure
    // truncation for this caller must not fall back to it.
    const { headers, res } = fakeResponse();
    setListPaginationHeaders(res, {
      count: 1,
      limit: 1,
      offset: 0,
      truncated: "unknown",
    });
    expect(headers.get(LIST_RESULT_TRUNCATED_HEADER)).toBe("unknown");
  });

  it("omits the total when the route did not compute one", () => {
    const { headers, res } = fakeResponse();
    setListPaginationHeaders(res, {
      count: 3,
      limit: 500,
      offset: 0,
      truncated: false,
    });
    expect(headers.has(LIST_TOTAL_COUNT_HEADER)).toBe(false);
  });

  it("publishes the total when the route computed one", () => {
    const { headers, res } = fakeResponse();
    setListPaginationHeaders(res, {
      count: 1000,
      limit: 1000,
      offset: 0,
      truncated: true,
      total: 26_374,
    });
    expect(headers.get(LIST_TOTAL_COUNT_HEADER)).toBe("26374");
  });

  it("omits the applied-limit header when no limit was applied", () => {
    const { headers, res } = fakeResponse();
    setListPaginationHeaders(res, {
      count: 7,
      offset: 0,
      truncated: false,
      total: 7,
    });
    expect(headers.has(LIST_RESULT_LIMIT_HEADER)).toBe(false);
    expect(headers.get(LIST_RESULT_TRUNCATED_HEADER)).toBe("false");
  });
});
