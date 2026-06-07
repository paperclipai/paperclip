import { describe, expect, it } from "vitest";
import { shouldSilenceHttpSuccessLog, shouldDownlevel404ToDebug } from "../middleware/http-log-policy.js";

describe("shouldSilenceHttpSuccessLog", () => {
  it("silences cached 304 responses", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/issues/PAP-1383", 304)).toBe(true);
  });

  it("silences successful polling endpoints", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 200)).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/heartbeat-runs",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/heartbeat-runs/b7044268-19b6-4b3a-a9f3-9c57dce70253/log?offset=1103894&limitBytes=256000",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/live-runs?minCount=3",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "HEAD",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/sidebar-badges",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/issues?includeRoutineExecutions=true",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/activity",
        200,
      ),
    ).toBe(true);
  });

  it("silences successful static asset requests", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/index.html", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/@fs/Users/dotta/paperclip/ui/src/main.tsx", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/src/App.tsx?t=123", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/site.webmanifest", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/sw.js", 200)).toBe(true);
  });

  it("keeps normal successful application requests", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/issues/PAP-1383", 200)).toBe(false);
    expect(shouldSilenceHttpSuccessLog("PATCH", "/api/issues/PAP-1383", 200)).toBe(false);
  });

  it("keeps failing requests visible", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 500)).toBe(false);
    expect(shouldSilenceHttpSuccessLog("GET", "/@fs/Users/dotta/paperclip/ui/src/main.tsx", 404)).toBe(false);
  });
});

describe("shouldDownlevel404ToDebug", () => {
  it("downlevels stale issue ID 404s", () => {
    expect(shouldDownlevel404ToDebug("GET", "/api/issues/abc-123", 404)).toBe(true);
    expect(shouldDownlevel404ToDebug("GET", "/api/issues/PAP-1383", 404)).toBe(true);
    expect(
      shouldDownlevel404ToDebug("GET", "/api/issues/52acb19a-057f-42b0-b049-2e6a7a532aab", 404),
    ).toBe(true);
  });

  it("downlevels stale heartbeat run log 404s", () => {
    expect(
      shouldDownlevel404ToDebug(
        "GET",
        "/api/heartbeat-runs/b7044268-19b6-4b3a-a9f3-9c57dce70253/log?offset=1103894&limitBytes=256000",
        404,
      ),
    ).toBe(true);
  });

  it("does not downlevel non-GET methods", () => {
    expect(shouldDownlevel404ToDebug("POST", "/api/issues/abc-123", 404)).toBe(false);
    expect(shouldDownlevel404ToDebug("PATCH", "/api/issues/abc-123", 404)).toBe(false);
  });

  it("does not downlevel non-404 status codes", () => {
    expect(shouldDownlevel404ToDebug("GET", "/api/issues/abc-123", 200)).toBe(false);
    expect(shouldDownlevel404ToDebug("GET", "/api/issues/abc-123", 500)).toBe(false);
  });

  it("does not downlevel sub-routes of issues/:id", () => {
    expect(shouldDownlevel404ToDebug("GET", "/api/issues/abc-123/comments", 404)).toBe(false);
    expect(shouldDownlevel404ToDebug("GET", "/api/issues/abc-123/documents/plan", 404)).toBe(false);
  });

  it("does not downlevel unknown 404 routes", () => {
    expect(shouldDownlevel404ToDebug("GET", "/api/companies/x/issues", 404)).toBe(false);
    expect(shouldDownlevel404ToDebug("GET", "/api/agents/me", 404)).toBe(false);
  });
});
