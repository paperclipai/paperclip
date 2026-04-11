import { afterEach, describe, expect, it } from "vitest";

import { getRuntimeLocaleConfig, setRuntimeLocaleConfig } from "./runtime-locale";
import { timeAgo } from "./timeAgo";

const originalConfig = getRuntimeLocaleConfig();

afterEach(() => setRuntimeLocaleConfig(originalConfig));

describe("timeAgo", () => {
  it("formats zh-CN relative time", () => {
    setRuntimeLocaleConfig({ locale: "zh-CN", timeZone: "Asia/Shanghai", currencyCode: "CNY" });

    expect(timeAgo(new Date(Date.now() - 2 * 60 * 60 * 1000))).toBe("2小时前");
  });

  it("keeps English relative time for en", () => {
    setRuntimeLocaleConfig({ locale: "en", timeZone: "UTC", currencyCode: "USD" });

    expect(timeAgo(new Date(Date.now() - 5 * 60 * 1000))).toBe("5m ago");
  });
});
