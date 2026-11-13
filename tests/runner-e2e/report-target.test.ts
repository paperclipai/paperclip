import { describe, expect, it } from "vitest";
import { reportEvidenceHref, reportTargetUrl } from "./report-target.js";
import type { RunnerE2EResult } from "./types.js";

describe("tested application URL", () => {
  it("uses recorded targets without inferring a URL from the worker environment", () => {
    expect(reportTargetUrl({ targetUrl: "https://qa.example.test" } as RunnerE2EResult)).toBe("https://qa.example.test/");
    expect(reportTargetUrl({ productJourney: { deployment: { origin: "https://cloud.example.test" } } } as RunnerE2EResult)).toBe("https://cloud.example.test/");
    expect(reportTargetUrl({ providerConnection: { target: { origin: "http://localhost:3100" } } } as RunnerE2EResult)).toBe("http://localhost:3100/");
    expect(reportTargetUrl({ environmentId: "daytona" } as RunnerE2EResult)).toBeNull();
    expect(reportTargetUrl(undefined)).toBeNull();
  });

  it.each(["javascript:alert(1)", "https://user:secret@example.test", "invalid"])("does not link unsafe or invalid values: %s", targetUrl => {
    expect(reportTargetUrl({ targetUrl } as RunnerE2EResult)).toBeNull();
  });

  it("allows report-relative evidence and safe external links", () => {
    expect(reportEvidenceHref("provenance.json")).toBe("provenance.json");
    expect(reportEvidenceHref("../history/#run")).toBe("../history/#run");
    expect(reportEvidenceHref("https://example.test/evals/")).toBe("https://example.test/evals/");
  });

  it.each(["javascript:alert(1)", "data:text/html,unsafe", "https://user:secret@example.test", "//user:secret@example.test", ""])("omits unsafe evidence destinations: %s", href => {
    expect(reportEvidenceHref(href)).toBeNull();
  });
});
