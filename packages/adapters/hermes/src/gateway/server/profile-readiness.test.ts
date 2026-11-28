import { afterEach, describe, expect, it, vi } from "vitest";
import { testEnvironment } from "./test.js";

const target = "http://127.0.0.1:8642/p/fixture-target";
const key = "fixture-gateway-credential";
const config = { apiBaseUrl: target, apiKey: key, expectedProfile: "fixture-target" };

function testGateway(overrides: Record<string, unknown> = {}) {
  return testEnvironment({ companyId: "fixture-company", adapterType: "hermes_gateway", config: { ...config, ...overrides } });
}

function ready() {
  return {
    platform: "hermes-agent", status: "ok", gateway_state: "running", gateway_busy: false, active_agents: 0,
    readiness: { status: "ok", checks: { background_queues: {
      status: "ok", active_api_runs: 0, active_delegations: 0, process_completions: 0,
    } } },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Hermes Gateway named profile readiness", () => {
  it("requires authentication and uses the saved bearer on the exact named route", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json(ready()));
    vi.stubGlobal("fetch", fetch);

    expect(await testGateway()).toMatchObject({
      status: "pass",
      checks: expect.arrayContaining([expect.objectContaining({ code: "hermes_gateway_profile_ready" })]),
    });
    expect(fetch).toHaveBeenNthCalledWith(1, target + "/health/detailed", expect.objectContaining({ redirect: "error" }));
    expect(fetch.mock.calls[0][1].headers).toBeUndefined();
    expect(fetch).toHaveBeenNthCalledWith(2, target + "/health/detailed", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${key}` }),
      redirect: "error",
    }));
  });

  it.each([
    [404, "hermes_gateway_profile_not_served"],
    [200, "hermes_gateway_profile_auth_unverified"],
  ])("does not send a bearer when the anonymous response is %i", async (status, code) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal("fetch", fetch);
    expect(await testGateway()).toMatchObject({
      status: "fail", checks: expect.arrayContaining([expect.objectContaining({ code })]),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not probe a base URL configured for a different profile", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await testGateway({ apiBaseUrl: "http://127.0.0.1:8642/p/decoy" })).toMatchObject({
      status: "fail",
      checks: expect.arrayContaining([expect.objectContaining({ code: "hermes_gateway_profile_url_mismatch" })]),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [new Response(null, { status: 401 }), "hermes_gateway_profile_auth_failed"],
    [Response.json({ status: "ok", platform: "hermes-agent" }), "hermes_gateway_profile_not_ready"],
    [Response.json({ ...ready(), active_agents: 1 }), "hermes_gateway_profile_not_ready"],
  ])("rejects an authenticated response that cannot prove readiness", async (response, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(response));
    const result = await testGateway();
    expect(result).toMatchObject({
      status: "fail", checks: expect.arrayContaining([expect.objectContaining({ code })]),
    });
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("retains the reachability check for existing bindings", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ status: "ok" }));
    vi.stubGlobal("fetch", fetch);
    expect(await testGateway({ expectedProfile: undefined })).toMatchObject({
      status: "pass",
      checks: expect.arrayContaining([expect.objectContaining({ code: "hermes_gateway_health_ok" })]),
    });
    expect(fetch).toHaveBeenCalledWith(target + "/health", expect.anything());
  });
});
