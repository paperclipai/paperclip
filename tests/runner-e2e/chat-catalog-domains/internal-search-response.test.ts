import { describe, expect, it, vi } from "vitest";
import { readSearchProbeResponse } from "./internal-search-response.js";
describe("actual search response body ownership", () => {
  it("reproduces the retained locked-stream observer failure with a real Response", async () => {
    const response = new Response(JSON.stringify({ results: [{ id: "source" }] }), { status: 200 });
    await response.json(); expect(response.bodyUsed).toBe(true); expect(response.body?.locked).toBe(true);
    await expect(response.body!.cancel()).rejects.toThrow("ReadableStream is locked");
  });
  it("returns actual parsed search bytes without cancelling an already consumed successful body", async () => {
    const response = new Response(JSON.stringify({ results: [{ id: "source" }] }), { status: 200 });
    const cancel = vi.spyOn(response.body!, "cancel");
    expect(await readSearchProbeResponse(response)).toEqual({ status: 200, body: { results: [{ id: "source" }] } });
    expect(cancel).not.toHaveBeenCalled(); expect(response.bodyUsed).toBe(true);
  });
  it.each([403, 404])("cancels an unread denied body, retaining actual %s and exposing no restricted bytes", async status => {
    const response = new Response("Restricted source body", { status });
    const cancel = vi.spyOn(response.body!, "cancel");
    expect(await readSearchProbeResponse(response)).toEqual({ status, body: null });
    expect(cancel).toHaveBeenCalledOnce(); expect(response.bodyUsed).toBe(true);
  });
  it("propagates invalid successful JSON instead of inventing empty search results", async () => {
    await expect(readSearchProbeResponse(new Response("not JSON", { status: 200 }))).rejects.toThrow();
  });
});
