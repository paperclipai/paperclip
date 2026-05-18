import { describe, expect, it } from "vitest";
import { shouldSilenceHttpSuccessLog } from "../middleware/http-log-policy.js";

describe("shouldSilenceHttpSuccessLog", () => {
  it("silences cached 304 responses", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 304)).toBe(true);
  });

  it("silences successful polling endpoints", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/companies/company-1/heartbeat-runs", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/api/companies/company-1/live-runs", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/api/companies/company-1/sidebar-badges", 200)).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/heartbeat-runs/b7044268-19b6-4b3a-a9f3-9c57dce70253/log?offset=0&limitBytes=256000",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/heartbeat-runs/b7044268-19b6-4b3a-a9f3-9c57dce70253/log/stream?offset=1103894&limitBytes=256000",
        200,
      ),
    ).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health/", 200)).toBe(true);
  });

  it("silences successful static asset requests", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/assets/index.js", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/favicon.ico", 200)).toBe(true);
  });

  it("keeps normal successful application requests", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/issues/issue-1", 200)).toBe(false);
    expect(shouldSilenceHttpSuccessLog("POST", "/api/issues", 200)).toBe(false);
  });

  it("keeps failing requests visible", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 500)).toBe(false);
    expect(shouldSilenceHttpSuccessLog("GET", "/api/companies/company-1/sidebar-badges", 500)).toBe(false);
  });
});
