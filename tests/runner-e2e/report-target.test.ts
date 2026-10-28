import { describe, expect, it } from "vitest";
import { reportTargetUrl } from "./report-target.js";
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
});
