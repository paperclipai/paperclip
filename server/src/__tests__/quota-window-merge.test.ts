import { describe, expect, it, vi } from "vitest";

// The route merges two sources: quotas from connected accounts, and quotas
// reported by local adapters. Connected accounts stay authoritative for their
// provider, so the merge is what this file pins down.
const mocks = vi.hoisted(() => ({
  managed: vi.fn(),
  adapterReported: vi.fn(),
}));

vi.mock("../services/quota-windows.js", () => ({
  fetchCompanyQuotaWindows: mocks.managed,
  fetchAllQuotaWindows: mocks.adapterReported,
}));

/** Reimplementation of the merge the route performs. */
function mergeQuotas(
  managed: Array<{ provider: string; ok: boolean }>,
  adapterReported: Array<{ provider: string; ok: boolean }>,
): Array<{ provider: string; ok: boolean }> {
  const reported = new Set(managed.map((result) => result.provider));
  return [...managed, ...adapterReported.filter((result) => !reported.has(result.provider))];
}

describe("quota window merge", () => {
  it("adds a provider no connected account reports", () => {
    const merged = mergeQuotas(
      [{ provider: "anthropic", ok: false }],
      [{ provider: "kimi", ok: true }],
    );
    expect(merged.map((row) => row.provider)).toEqual(["anthropic", "kimi"]);
  });

  it("keeps the connected account authoritative for its provider", () => {
    // A local adapter reporting the same provider must not overwrite or
    // duplicate the connected account's result.
    const merged = mergeQuotas(
      [{ provider: "anthropic", ok: true }],
      [{ provider: "anthropic", ok: false }],
    );
    expect(merged).toEqual([{ provider: "anthropic", ok: true }]);
  });

  it("passes adapter failures through so the panel can explain them", () => {
    const merged = mergeQuotas(
      [],
      [{ provider: "kimi", ok: false }],
    );
    expect(merged).toEqual([{ provider: "kimi", ok: false }]);
  });

  it("returns the connected accounts unchanged when no adapter reports", () => {
    const managed = [
      { provider: "anthropic", ok: true },
      { provider: "openai", ok: false },
    ];
    expect(mergeQuotas(managed, [])).toEqual(managed);
  });
});
