import { describe, expect, it } from "vitest";
import type { ProviderQuotaResult } from "@paperclipai/adapter-utils";
import { mergeQuotaWindowResults } from "../services/quota-windows.js";

function result(provider: string, ok: boolean): ProviderQuotaResult {
  return { provider, ok, windows: [] };
}

describe("mergeQuotaWindowResults", () => {
  it("adds a provider no connected account reports", () => {
    const merged = mergeQuotaWindowResults(
      [result("anthropic", false)],
      [result("kimi", true)],
    );
    expect(merged.map((row) => row.provider)).toEqual(["anthropic", "kimi"]);
  });

  it("keeps the connected account authoritative for its provider", () => {
    // A local adapter reporting the same provider must not overwrite or
    // duplicate the connected account's result.
    const merged = mergeQuotaWindowResults(
      [result("anthropic", true)],
      [result("anthropic", false)],
    );
    expect(merged).toEqual([result("anthropic", true)]);
  });

  it("passes adapter failures through so the panel can explain them", () => {
    const merged = mergeQuotaWindowResults([], [result("kimi", false)]);
    expect(merged).toEqual([result("kimi", false)]);
  });

  it("returns the connected accounts unchanged when no adapter reports", () => {
    const managed = [result("anthropic", true), result("openai", false)];
    expect(mergeQuotaWindowResults(managed, [])).toEqual(managed);
  });
});
