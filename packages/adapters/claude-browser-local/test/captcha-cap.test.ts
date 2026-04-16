import { describe, expect, it } from "vitest";
import {
  CaptchaCapExceededError,
  CaptchaClient,
  DEFAULT_MONTHLY_CAP_USD,
} from "../src/server/tools/captcha.js";

function inMemorySpendStore(initial = 0) {
  let spend = initial;
  return {
    async getMonthlySpendUsd() {
      return spend;
    },
    async addSpendUsd(delta: number) {
      spend += delta;
    },
    _read: () => spend,
  };
}

describe("CaptchaClient cap enforcement", () => {
  it("throws CaptchaCapExceededError before calling provider when cap is reached", async () => {
    const store = inMemorySpendStore(DEFAULT_MONTHLY_CAP_USD);
    const client = new CaptchaClient({
      apiKey: "test",
      spendStore: store,
    });
    await expect(
      client.solve({
        siteKey: "sk",
        pageUrl: "https://example.test",
        kind: "recaptcha_v2",
      }),
    ).rejects.toBeInstanceOf(CaptchaCapExceededError);
    // spend must not advance when we refuse.
    expect(store._read()).toBe(DEFAULT_MONTHLY_CAP_USD);
  });

  it("throws CaptchaCapExceededError when the next call would push over the cap", async () => {
    const store = inMemorySpendStore(DEFAULT_MONTHLY_CAP_USD - 0.001);
    const client = new CaptchaClient({
      apiKey: "test",
      monthlyCapUsd: DEFAULT_MONTHLY_CAP_USD,
      spendStore: store,
    });
    await expect(
      client.solve({
        siteKey: "sk",
        pageUrl: "https://example.test",
        kind: "recaptcha_v2",
        estimatedCostUsd: 0.01,
      }),
    ).rejects.toBeInstanceOf(CaptchaCapExceededError);
  });

  it("respects a custom (lower) cap", async () => {
    const store = inMemorySpendStore(1);
    const client = new CaptchaClient({
      apiKey: "test",
      monthlyCapUsd: 1,
      spendStore: store,
    });
    await expect(
      client.solve({
        siteKey: "sk",
        pageUrl: "https://example.test",
        kind: "recaptcha_v2",
      }),
    ).rejects.toBeInstanceOf(CaptchaCapExceededError);
  });
});
