import type { Daytona } from "@daytonaio/sdk";
import { describe, expect, it, vi } from "vitest";
import { daytonaServiceResourcesMatch, verifyDaytonaServiceResourceConfiguration } from "./service-resources.js";

describe("Daytona service resource allocation verification", () => {
  const requested = { cpu: 4, memory: 8, disk: 20 };
  function fixture() {
    const get = vi.fn(async () => ({ cpu: 4, mem: 8, disk: 20, gpu: 0 }));
    return { get, client: { snapshot: { get } } as unknown as Pick<Daytona, "snapshot"> };
  }
  it("verifies configured snapshot sizes through the SDK's memory field", async () => {
    const f = fixture();
    expect(await verifyDaytonaServiceResourceConfiguration(f.client, { snapshot: "app", ...requested })).toBe(true);
    expect(f.get).toHaveBeenCalledExactlyOnceWith("app");
    f.get.mockResolvedValueOnce({ cpu: 4, mem: 16, disk: 20, gpu: 0 });
    expect(await verifyDaytonaServiceResourceConfiguration(f.client, { snapshot: "app", ...requested })).toBe(false);
  });
  it("accepts explicit image resource settings without a snapshot lookup", async () => {
    const f = fixture();
    expect(await verifyDaytonaServiceResourceConfiguration(f.client, { image: "node:24", ...requested })).toBe(true);
    expect(await verifyDaytonaServiceResourceConfiguration(f.client, {})).toBe(true);
    expect(f.get).not.toHaveBeenCalled();
    expect(await verifyDaytonaServiceResourceConfiguration(f.client, requested)).toBe(false);
  });
  it.each([0, -1, 1.5, NaN, Infinity, "four", "4", { secretId: "bad" }])("rejects an invalid configured size (%j) without substituting a default", async (value) => {
    const f = fixture();
    expect(await verifyDaytonaServiceResourceConfiguration(f.client, { image: "node:24", cpu: value })).toBe(false);
    expect(daytonaServiceResourcesMatch({ cpu: 4 }, { cpu: value })).toBe(false);
    expect(f.get).not.toHaveBeenCalled();
  });
  it("requires actual configured sizes, including undersizing and unavailable provider fields", () => {
    expect(daytonaServiceResourcesMatch({ ...requested, gpu: 0 }, requested)).toBe(true);
    for (const actual of [{ ...requested, cpu: 2 }, { ...requested, cpu: 8 }, { ...requested, memory: undefined }, { ...requested, disk: NaN }]) {
      expect(daytonaServiceResourcesMatch(actual, requested)).toBe(false);
    }
    expect(daytonaServiceResourcesMatch({}, {})).toBe(true);
  });
  it("does not turn provider errors into a successful size verification", async () => {
    const f = fixture(); f.get.mockRejectedValueOnce(new Error("snapshot unavailable"));
    await expect(verifyDaytonaServiceResourceConfiguration(f.client, { snapshot: "app", ...requested })).rejects.toThrow("snapshot unavailable");
  });
});
