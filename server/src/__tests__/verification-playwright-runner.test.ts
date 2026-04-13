import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runPlaywrightSpec } from "../services/verification/runners/playwright-runner.js";

function wrap(reportJson: string): string {
  return `some install noise\n---PW-REPORT-START---\n${reportJson}\n---PW-REPORT-END---\n`;
}

const PASSED_REPORT = wrap(
  JSON.stringify({
    stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0, duration: 2500 },
    suites: [],
  }),
);

const FAILED_REPORT = wrap(
  JSON.stringify({
    stats: { expected: 0, unexpected: 1, skipped: 0, flaky: 0, duration: 1500 },
    suites: [
      {
        specs: [
          {
            title: "reaches demo without redirect",
            tests: [
              {
                results: [
                  {
                    status: "failed",
                    error: { message: "expected URL /tiktok-demo, got /sign-in" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  }),
);

describe("runPlaywrightSpec", () => {
  beforeEach(() => {
    process.env.BROWSER_TEST_HOST = "test.host";
    process.env.BROWSER_TEST_SSH_KEY = "/tmp/key";
    process.env.BROWSER_TEST_USER = "root";
  });
  afterEach(() => {
    delete process.env.BROWSER_TEST_HOST;
    delete process.env.BROWSER_TEST_SSH_KEY;
    delete process.env.BROWSER_TEST_USER;
  });

  it("returns unavailable if BROWSER_TEST_HOST is not set", async () => {
    delete process.env.BROWSER_TEST_HOST;
    const result = await runPlaywrightSpec({
      issueId: "abc",
      specPath: "skills/acceptance-viracue/tests/DLD-1.url.spec.ts",
      context: "anonymous",
      targetSha: "sha1",
      targetUrl: "https://viracue.ai",
      waitForShaFn: async () => ({ matched: true, deployedSha: "sha1" }),
      ssh: async () => ({ stdout: PASSED_REPORT, stderr: "", exitCode: 0 }),
    });
    expect(result.status).toBe("unavailable");
  });

  it("returns unavailable when deployed SHA doesn't match", async () => {
    const result = await runPlaywrightSpec({
      issueId: "abc",
      specPath: "skills/acceptance-viracue/tests/DLD-1.url.spec.ts",
      context: "anonymous",
      targetSha: "sha-expected",
      targetUrl: "https://viracue.ai",
      waitForShaFn: async () => ({ matched: false, deployedSha: "sha-old" }),
      ssh: async () => ({ stdout: PASSED_REPORT, stderr: "", exitCode: 0 }),
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.unavailableReason).toContain("deploy_not_ready");
    }
  });

  it("returns unavailable on invalid spec_path format", async () => {
    const result = await runPlaywrightSpec({
      issueId: "abc",
      specPath: "no-tests-segment.spec.ts",
      context: "anonymous",
      targetSha: "sha1",
      targetUrl: "https://viracue.ai",
      waitForShaFn: async () => ({ matched: true, deployedSha: "sha1" }),
      ssh: async () => ({ stdout: PASSED_REPORT, stderr: "", exitCode: 0 }),
    });
    expect(result.status).toBe("unavailable");
  });

  it("returns unavailable on spec_path with shell metacharacters", async () => {
    const result = await runPlaywrightSpec({
      issueId: "abc",
      specPath: "skills/acceptance-viracue/tests/DLD-1.url.spec.ts; rm -rf /",
      context: "anonymous",
      targetSha: "sha1",
      targetUrl: "https://viracue.ai",
      waitForShaFn: async () => ({ matched: true, deployedSha: "sha1" }),
      ssh: async () => ({ stdout: PASSED_REPORT, stderr: "", exitCode: 0 }),
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.unavailableReason).toContain("invalid spec_path format");
    }
  });

  it("returns passed when playwright reports 0 failures", async () => {
    const ssh = vi.fn().mockResolvedValue({ stdout: PASSED_REPORT, stderr: "", exitCode: 0 });
    const result = await runPlaywrightSpec({
      issueId: "abc",
      specPath: "skills/acceptance-viracue/tests/DLD-1.url.spec.ts",
      context: "anonymous",
      targetSha: "sha1",
      targetUrl: "https://viracue.ai",
      waitForShaFn: async () => ({ matched: true, deployedSha: "sha1" }),
      ssh,
    });
    expect(result.status).toBe("passed");
    if (result.status === "passed") {
      expect(result.deployedSha).toBe("sha1");
    }
  });

  it("returns failed with summary when playwright reports 1 failure", async () => {
    const result = await runPlaywrightSpec({
      issueId: "abc",
      specPath: "skills/acceptance-viracue/tests/DLD-2793.url.spec.ts",
      context: "anonymous",
      targetSha: "sha1",
      targetUrl: "https://viracue.ai",
      waitForShaFn: async () => ({ matched: true, deployedSha: "sha1" }),
      ssh: async () => ({ stdout: FAILED_REPORT, stderr: "", exitCode: 1 }),
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureSummary).toContain("expected URL /tiktok-demo, got /sign-in");
    }
  });

  it("returns unavailable when ssh throws", async () => {
    const result = await runPlaywrightSpec({
      issueId: "abc",
      specPath: "skills/acceptance-viracue/tests/DLD-1.url.spec.ts",
      context: "anonymous",
      targetSha: "sha1",
      targetUrl: "https://viracue.ai",
      waitForShaFn: async () => ({ matched: true, deployedSha: "sha1" }),
      ssh: async () => {
        throw new Error("Connection refused");
      },
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.unavailableReason).toContain("Connection refused");
    }
  });

  it("returns unavailable when stdout has no markers", async () => {
    const result = await runPlaywrightSpec({
      issueId: "abc",
      specPath: "skills/acceptance-viracue/tests/DLD-1.url.spec.ts",
      context: "anonymous",
      targetSha: "sha1",
      targetUrl: "https://viracue.ai",
      waitForShaFn: async () => ({ matched: true, deployedSha: "sha1" }),
      ssh: async () => ({ stdout: "Error: npm ENOENT", stderr: "", exitCode: 1 }),
    });
    expect(result.status).toBe("unavailable");
  });

  it("returns unavailable when playwright reports zero tests executed", async () => {
    const zeroTestsReport = wrap(
      JSON.stringify({
        stats: { expected: 0, unexpected: 0, skipped: 0, flaky: 0, duration: 100 },
        suites: [],
      }),
    );
    const result = await runPlaywrightSpec({
      issueId: "abc",
      specPath: "skills/acceptance-viracue/tests/DLD-1.url.spec.ts",
      context: "anonymous",
      targetSha: "sha1",
      targetUrl: "https://viracue.ai",
      waitForShaFn: async () => ({ matched: true, deployedSha: "sha1" }),
      ssh: async () => ({ stdout: zeroTestsReport, stderr: "", exitCode: 0 }),
    });
    expect(result.status).toBe("unavailable");
  });
});
