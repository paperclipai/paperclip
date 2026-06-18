import { describe, expect, it, vi } from "vitest";

const setAdapterDisabled = vi.fn();

vi.mock("../adapters/registry.js", async (orig) => ({
  ...(await orig()),
  listServerAdapters: () => [
    { type: "claude_local" },
    { type: "opencode_local" },
    { type: "pi_local" },
  ],
}));

vi.mock("./adapter-plugin-store.js", () => ({
  setAdapterDisabled: (type: string, disabled: boolean) => setAdapterDisabled(type, disabled),
}));

const { reconcileAdapterAvailability } = await import("./adapter-registry-bootstrap.js");

describe("reconcileAdapterAvailability", () => {
  it("is a no-op when registry is null", () => {
    setAdapterDisabled.mockReset();
    expect(reconcileAdapterAvailability(null)).toEqual({ enabled: [], disabled: [] });
    expect(setAdapterDisabled).not.toHaveBeenCalled();
  });

  it("enables declared, disables everything else (e.g. drops claude_local)", () => {
    setAdapterDisabled.mockReset();
    const result = reconcileAdapterAvailability([
      { adapterType: "opencode_local", enabled: true },
    ]);
    expect(result.enabled).toEqual(["opencode_local"]);
    expect(result.disabled.sort()).toEqual(["claude_local", "pi_local"]);
    expect(setAdapterDisabled).toHaveBeenCalledWith("claude_local", true);
    expect(setAdapterDisabled).toHaveBeenCalledWith("opencode_local", false);
  });

  it("throws when a declared adapter has no installed implementation", () => {
    setAdapterDisabled.mockReset();
    expect(() =>
      reconcileAdapterAvailability([{ adapterType: "ghost_adapter", enabled: true }]),
    ).toThrow(/no installed adapter: ghost_adapter/);
  });
});
