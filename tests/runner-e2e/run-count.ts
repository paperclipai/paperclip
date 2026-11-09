import type { RunnerTaskFixture } from "./types.js";

type RunCountContract = Pick<RunnerTaskFixture, "expectedRunCount" | "minimumExpectedRunCount">;
export const minimumRunCount = (task: RunCountContract) => task.minimumExpectedRunCount ?? task.expectedRunCount;
export const matchesRunCount = (task: RunCountContract, count: number) =>
  count >= minimumRunCount(task) && count <= task.expectedRunCount;
