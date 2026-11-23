import { describe, expect, it } from "vitest";
import { IdleApiActivity } from "./idle-api-activity.js";

describe("authenticated API idle activity", () => {
  it("is passive without successful authentication and expires without timers or dependency work", () => {
    let monotonic = 1;
    const activity = new IdleApiActivity(() => monotonic);
    expect(activity.active()).toBe(false);
    activity.record();
    expect(activity.active()).toBe(true);
    monotonic += 599_999;
    expect(activity.active()).toBe(true);
    monotonic++;
    expect(activity.active()).toBe(false);
  });
  it("extends only from the actual latest successful use and ignores wall clock changes", () => {
    let monotonic = 1;
    const activity = new IdleApiActivity(() => monotonic);
    activity.record();
    monotonic += 300_000;
    activity.record();
    monotonic += 300_001;
    expect(activity.active()).toBe(true);
    monotonic += 299_999;
    expect(activity.active()).toBe(false);
  });
});
