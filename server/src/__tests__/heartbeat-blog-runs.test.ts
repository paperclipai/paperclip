import { describe, expect, it, vi } from "vitest";
import { heartbeatService } from "../services/heartbeat.ts";

describe("heartbeat blog run bridge", () => {
  it("delegates blog run execution to the blog run worker", async () => {
    const runNext = vi.fn().mockResolvedValue({
      run: {
        id: "run-1",
        status: "research_ready",
        currentStep: "draft",
      },
    });

    const heartbeat = heartbeatService({} as any, {
      blogRunWorkerFactory: () => ({
        runNext,
      }),
    });

    const result = await heartbeat.runBlogRunStep("run-1");

    expect(runNext).toHaveBeenCalledWith("run-1");
    expect(result).toMatchObject({
      run: {
        id: "run-1",
        status: "research_ready",
        currentStep: "draft",
      },
    });
  });
});
