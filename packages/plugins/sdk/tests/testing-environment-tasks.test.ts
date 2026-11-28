import { expect, it } from "vitest";
import { createTestHarness } from "../src/testing.js";
import type { PaperclipPluginManifestV1 } from "../src/types.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "fixture.environment-tasks", apiVersion: 1, version: "1.0.0", displayName: "Environment tasks",
  description: "Fixture", author: "Tests", categories: ["automation"],
  capabilities: ["environment.drivers.register"], entrypoints: { worker: "./worker.js" },
};

it("records startup stage reports for a driver plugin and requires its capability", async () => {
  const harness = createTestHarness({ manifest });
  await harness.ctx.environmentTasks.reportStartupStage({ taskId: "task-1", stage: "starting_environment" });
  await harness.ctx.environmentTasks.reportStartupStage({ taskId: "task-1", stage: "preparing_workspace" });
  expect(harness.startupStageReports).toEqual([
    { taskId: "task-1", stage: "starting_environment" },
    { taskId: "task-1", stage: "preparing_workspace" },
  ]);
  const denied = createTestHarness({ manifest, capabilities: [] });
  await expect(denied.ctx.environmentTasks.reportStartupStage({ taskId: "task-1", stage: "starting_agent" }))
    .rejects.toThrow("environment.drivers.register");
});
