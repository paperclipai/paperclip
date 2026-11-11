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

  it("lets a successful adapter report replace an unconnected placeholder", () => {
    // Operators with a working host-local login but no connected account must
    // see their adapter-reported quota, not the connect hint.
    const placeholder: ProviderQuotaResult = {
      ...result("anthropic", false),
      accountKey: "unconnected:company-1:anthropic",
      error: "Connect a subscription account in AI connections to view its quota.",
    };
    const merged = mergeQuotaWindowResults([placeholder], [result("anthropic", true)]);
    expect(merged).toEqual([result("anthropic", true)]);
  });

  it("keeps the connect hint when the adapter probe also fails", () => {
    const placeholder: ProviderQuotaResult = {
      ...result("anthropic", false),
      accountKey: "unconnected:company-1:anthropic",
      error: "Connect a subscription account in AI connections to view its quota.",
    };
    const merged = mergeQuotaWindowResults([placeholder], [result("anthropic", false)]);
    expect(merged).toEqual([placeholder]);
  });

  it("treats results without an accountKey as authoritative", () => {
    // Adapter-reported and test-shaped results carry no accountKey. They must
    // never be mistaken for a placeholder.
    const merged = mergeQuotaWindowResults(
      [result("anthropic", true)],
      [result("anthropic", true)],
    );
    expect(merged).toEqual([result("anthropic", true)]);
  });
});
