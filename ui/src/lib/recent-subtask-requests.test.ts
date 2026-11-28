import { expect, it } from "vitest";
import { readRecentSubtasks, RECENT_SUBTASK_CONCURRENCY } from "./recent-subtask-requests";

it("bounds simultaneous child HTTP reads and cancels queued groups before they start", async () => {
  let active = 0, peak = 0;
  const started: number[] = [];
  const releases: Array<() => void> = [];
  const controllers = Array.from({ length: 50 }, () => new AbortController());
  const work = controllers.map((controller, id) => readRecentSubtasks(controller.signal, async () => {
    started.push(id);
    peak = Math.max(peak, ++active);
    await new Promise<void>(resolve => releases.push(resolve));
    active--;
    if (id === 0) throw new Error("HTTP failure");
    return id;
  }));
  const settled = Promise.allSettled(work);
  await Promise.resolve();
  expect(started).toHaveLength(RECENT_SUBTASK_CONCURRENCY);
  controllers.slice(3, 49).forEach(controller => controller.abort());
  // One request fails; its slot still becomes available to the remaining group.
  releases.splice(0).forEach(release => release());
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(started).toEqual([0, 1, 2, 49]);
  releases.splice(0).forEach(release => release());
  const results = await settled;
  expect(peak).toBe(3);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(3);
  expect(results.at(-1)).toEqual({ status: "fulfilled", value: 49 });
});
