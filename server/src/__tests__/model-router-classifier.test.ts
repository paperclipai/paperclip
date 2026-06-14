import { describe, expect, it, vi } from "vitest";
import { classifyTaskComplexity, __resetClassifierCache } from "../services/model-router-classifier.ts";

function fakeFetch(content: string) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
  );
}

describe("classifyTaskComplexity", () => {
  it("maps a FAST verdict and caches it per issueId", async () => {
    __resetClassifierCache();
    const fetchImpl = fakeFetch("FAST");
    const args = { issueId: "i1", title: "Send digest", description: "", baseUrl: "http://x", model: "gemma", fetchImpl };
    expect(await classifyTaskComplexity(args)).toBe("fast");
    expect(await classifyTaskComplexity(args)).toBe("fast"); // cached
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps a REASONING verdict", async () => {
    __resetClassifierCache();
    const r = await classifyTaskComplexity({ issueId: "i2", title: "Debug race", description: "", baseUrl: "http://x", model: "gemma", fetchImpl: fakeFetch("REASONING") });
    expect(r).toBe("reasoning");
  });

  it("defaults to reasoning (safe) on unparseable output", async () => {
    __resetClassifierCache();
    const r = await classifyTaskComplexity({ issueId: "i3", title: "x", description: "", baseUrl: "http://x", model: "gemma", fetchImpl: fakeFetch("shrug") });
    expect(r).toBe("reasoning");
  });
});
