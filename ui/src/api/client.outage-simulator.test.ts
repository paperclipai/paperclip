// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeSimulatedOutage, api, OUTAGE_SIMULATOR_STORAGE_KEY, parseSimulatedOutage } from "./client";
import { classifyError, describeError } from "./errors";
import { healthApi } from "./health";

describe("dev outage simulator", () => {
  const fetchMock = vi.fn(async () => Response.json({ status: "ok" }));

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    window.localStorage.removeItem(OUTAGE_SIMULATOR_STORAGE_KEY);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it("parses the supported shapes", () => {
    expect(parseSimulatedOutage("503:tenant_app_unavailable")).toEqual({
      kind: "status", status: 503, code: "tenant_app_unavailable", durationMs: null,
    });
    expect(parseSimulatedOutage("502@20")).toEqual({ kind: "status", status: 502, code: null, durationMs: 20_000 });
    expect(parseSimulatedOutage("network")).toEqual({ kind: "network", durationMs: null });
    expect(parseSimulatedOutage("200")).toBeNull();
    expect(parseSimulatedOutage("yes please")).toBeNull();
    expect(parseSimulatedOutage(null)).toBeNull();
  });

  it("fails API requests with the chosen gateway code without calling the server", async () => {
    window.localStorage.setItem(OUTAGE_SIMULATOR_STORAGE_KEY, "503:tenant_app_unavailable");
    const error = await api.get("/companies").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "ApiError", status: 503, code: "tenant_app_unavailable" });
    expect(classifyError(error)).toBe("transient");
    expect((error as Error).message).not.toMatch(/tenant_app_unavailable/);
    expect(describeError(error).body).not.toMatch(/tenant_app_unavailable/);
    await expect(healthApi.get()).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("simulates a dropped connection", async () => {
    window.localStorage.setItem(OUTAGE_SIMULATOR_STORAGE_KEY, "network");
    const error = await api.get("/companies").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect(classifyError(error)).toBe("transient");
  });

  it("ends a timed outage on its own", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(OUTAGE_SIMULATOR_STORAGE_KEY, "503:tenant_app_unavailable@20");
    expect(activeSimulatedOutage()).not.toBeNull();
    vi.advanceTimersByTime(20_000);
    expect(activeSimulatedOutage()).toBeNull();
    expect(window.localStorage.getItem(OUTAGE_SIMULATOR_STORAGE_KEY)).toBeNull();
    await expect(api.get("/companies")).resolves.toEqual({ status: "ok" });
  });

  it("is a no-op when the key is absent", async () => {
    await expect(api.get("/companies")).resolves.toEqual({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
