import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { ProviderQuotaCard } from "../components/ProviderQuotaCard";
import { retainQuotaWindows } from "./quota-refresh";

const windows = [{ label: "5h limit", usedPercent: 37, resetsAt: null, valueLabel: null }];
const previous: ProviderQuotaResult[] = [
  { provider: "openai", source: "codex-rpc", ok: true, windows },
  { provider: "anthropic", source: "anthropic-oauth", ok: true, windows },
];

describe("provider quota refresh", () => {
  it("keeps account identity and original capture time across failures", () => {
    const prior = [{ ...previous[0], accountKey: "account-a", capturedAt: "2026-09-01T00:00:00Z" }];
    const failed = { provider: "openai", accountKey: "account-a", ok: false, windows: [] };
    expect(retainQuotaWindows(prior, [failed])[0]).toMatchObject({ windows, capturedAt: prior[0].capturedAt });
    expect(retainQuotaWindows(prior, [{ ...failed, accountKey: "account-b" }])[0].windows).toEqual([]);
    expect(retainQuotaWindows(prior, [])).toEqual([]);
  });

  it("retains failed provider windows through repeated failures while updating successful providers", () => {
    const incoming: ProviderQuotaResult[] = [
      { provider: "openai", ok: false, error: "failed", windows: [] },
      { provider: "anthropic", ok: true, windows: [] },
    ];
    const refreshed = retainQuotaWindows(previous, incoming);
    expect(refreshed[0]).toEqual({ ...incoming[0], source: "codex-rpc", windows });
    expect(refreshed[1].windows).toEqual([]);
    expect(retainQuotaWindows(refreshed, incoming)[0].windows).toEqual(windows);
    expect(incoming[0].windows).toEqual([]);
  });

  it("does not invent or copy windows for providers with no previous success", () => {
    const incoming = [{ provider: "unknown", ok: false, error: "failed", windows: [] }];
    expect(retainQuotaWindows(previous, incoming)).toEqual(incoming);
    expect(retainQuotaWindows(undefined, incoming)).toEqual(incoming);
  });

  it.each(["refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated", "credentials_unavailable", "authentication_required"])(
    "discards cached windows after credentials are rejected (%s)",
    (errorFamily) => {
      const transientFailure = [{ provider: "openai", ok: false, windows: [], error: "unavailable" }];
      const stale = retainQuotaWindows(previous, transientFailure);
      const rejected = [{ ...transientFailure[0], errorFamily }];
      expect(retainQuotaWindows(stale, rejected)).toEqual(rejected);
      // Later network failures must not restore the invalidated account's data.
      expect(retainQuotaWindows(rejected, transientFailure)[0].windows).toEqual([]);
      expect(previous[0].windows).toEqual(windows);
    },
  );

  it.each([
    ["anthropic", "claude-cli"],
    ["openai", "codex-rpc"],
    ["openai", null],
  ])("never renders raw quota errors for %s / %s", (provider, source) => {
    for (const quotaWindows of [[], windows]) {
      const html = renderToStaticMarkup(<ProviderQuotaCard
        provider={provider!} rows={[]} budgetMonthlyCents={0} totalCompanySpendCents={0}
        weekSpendCents={0} windowRows={[]} showDeficitNotch={false}
        quotaSource={source} quotaWindows={quotaWindows}
        quotaError={'Command failed: sh -c private-path --token private-secret'}
      />);
      expect(html).not.toContain("Command failed");
      expect(html).not.toContain("private-secret");
      expect(html).not.toContain("text-destructive");
      expect(html).toContain(quotaWindows.length ? "Showing the last available quota" : "Subscription quota is currently unavailable");
    }
  });
});
