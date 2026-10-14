import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localAgentRunnerTarget, resetLocalAgentRunnerTargetCacheForTests } from "../lib/agent-runner-platform.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const report = process.report as NodeJS.ProcessReport & { excludeNetwork: boolean };

describe("localAgentRunnerTarget", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
    resetLocalAgentRunnerTargetCacheForTests();
    report.excludeNetwork = false;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    resetLocalAgentRunnerTargetCacheForTests();
    vi.restoreAllMocks();
  });

  it("reads glibc from a report that excludes network data, then restores the setting", () => {
    const excludeNetworkDuringReport: boolean[] = [];
    vi.spyOn(process.report, "getReport").mockImplementation(() => {
      excludeNetworkDuringReport.push(report.excludeNetwork);
      return { header: { glibcVersionRuntime: "2.36" } } as never;
    });

    expect(localAgentRunnerTarget()).toMatchObject({ platform: "linux", libc: "glibc", glibcVersion: "2.36" });
    // Network data makes the report reverse-resolve every open socket with
    // synchronous DNS, which can stall the server.
    expect(excludeNetworkDuringReport).toEqual([true]);
    expect(report.excludeNetwork).toBe(false);
  });

  it("generates the report once per process", () => {
    const getReport = vi.spyOn(process.report, "getReport")
      .mockReturnValue({ header: { glibcVersionRuntime: "2.36" } } as never);

    for (let index = 0; index < 5; index += 1) localAgentRunnerTarget();

    expect(getReport).toHaveBeenCalledTimes(1);
  });

  it("reports an unknown libc once when the report fails, and restores the setting", () => {
    const getReport = vi.spyOn(process.report, "getReport").mockImplementation(() => {
      throw new Error("report unavailable");
    });

    expect(localAgentRunnerTarget()).toMatchObject({ libc: "unknown" });
    expect(localAgentRunnerTarget()).toMatchObject({ libc: "unknown" });
    expect(getReport).toHaveBeenCalledTimes(1);
    expect(report.excludeNetwork).toBe(false);
  });

  it("does not generate a report off Linux", () => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
    const getReport = vi.spyOn(process.report, "getReport");

    expect(localAgentRunnerTarget()).toEqual({ driver: "local", platform: "darwin", architecture: process.arch });
    expect(getReport).not.toHaveBeenCalled();
  });
});
