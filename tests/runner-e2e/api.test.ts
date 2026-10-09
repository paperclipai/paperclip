import { afterEach, describe, expect, it, vi } from "vitest";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { RunnerApi } from "./api.js";
const response = (status: number, data: unknown = {}): APIResponse => ({
  ok: () => status >= 200 && status < 300, status: () => status,
  json: async () => data, text: async () => JSON.stringify(data), url: () => "http://fixture.invalid/instructions",
}) as APIResponse;
afterEach(() => vi.unstubAllEnvs());
describe("fixture instruction revision fence", () => {
  function api(current: APIResponse, saved = response(200)) {
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_PORT", "3100");
    const request = { get: vi.fn(async () => current), put: vi.fn(async () => saved) };
    return { request, api: new RunnerApi(request as unknown as APIRequestContext) };
  }
  it.each([[404, {}, null], [200, { contentHash: "current-hash" }, "current-hash"]])("saves from a %s read with its exact base", async (status, detail, baseHash) => {
    const fixture = api(response(status as number, detail));
    await fixture.api.saveAgentInstructions("agent", "Fixture instructions");
    expect(fixture.request.get).toHaveBeenCalledWith("/api/agents/agent/instructions-bundle/file?path=AGENTS.md");
    expect(fixture.request.put).toHaveBeenCalledExactlyOnceWith("/api/agents/agent/instructions-bundle/file", {
      data: { path: "AGENTS.md", content: "Fixture instructions", baseHash },
    });
  });
  it.each([response(403), response(500), response(200, {})])("never treats a failed or incomplete read as a new file", async current => {
    const fixture = api(current);
    await expect(fixture.api.saveAgentInstructions("agent", "Fixture instructions")).rejects.toThrow();
    expect(fixture.request.put).not.toHaveBeenCalled();
  });
  it("surfaces a concurrent edit without retrying or overwriting it", async () => {
    const fixture = api(response(200, { contentHash: "old" }), response(409, { error: "Revision conflict" }));
    await expect(fixture.api.saveAgentInstructions("agent", "Fixture instructions")).rejects.toThrow("409");
    expect(fixture.request.get).toHaveBeenCalledTimes(1);
    expect(fixture.request.put).toHaveBeenCalledTimes(1);
  });
});
