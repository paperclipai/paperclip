import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { issuesApi } from "./issues";

const first = "11111111-1111-4111-8111-111111111111";
const second = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("issue summary HTTP requests", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes IDs, forwards cancellation, and disables the HTTP cache", async () => {
    fetchMock.mockResolvedValue(Response.json([]));
    const controller = new AbortController();
    await issuesApi.summaries("company", [second.toUpperCase(), ` ${first} `, first], { signal: controller.signal });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/companies/company/issues/summaries?ids=${first}%2C${second}`);
    expect(options.cache).toBe("no-store");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not send empty or oversized batches", async () => {
    expect(await issuesApi.summaries("company", [])).toEqual([]);
    await expect(issuesApi.summaries("company", Array(6).fill(first))).rejects.toThrow("Too many");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not reuse an in-flight response after an account change", async () => {
    let resolveOld!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(Response.json([{ id: first, title: "New account" }]));
    const oldAccount = issuesApi.summaries("company", [first]);
    const newAccount = issuesApi.summaries("company", [first]);
    expect((await newAccount)[0].title).toBe("New account");
    resolveOld(Response.json([{ id: first, title: "Old account" }]));
    expect((await oldAccount)[0].title).toBe("Old account");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts a summary request when its observer leaves", async () => {
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const controller = new AbortController();
    const pending = issuesApi.summaries("company", [first], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
