import { expect, test, describe } from "bun:test";
import { isQuietHours, canFireApprovalNow } from "../src/quiet-hours.js";

describe("quiet-hours window", () => {
  test("3am is quiet hours", () => {
    const t = new Date();
    t.setHours(3, 0, 0, 0);
    expect(isQuietHours(t)).toBe(true);
  });

  test("11am is NOT quiet hours", () => {
    const t = new Date();
    t.setHours(11, 0, 0, 0);
    expect(isQuietHours(t)).toBe(false);
  });

  test("9:30pm IS quiet hours (after 9pm boundary)", () => {
    const t = new Date();
    t.setHours(21, 30, 0, 0);
    expect(isQuietHours(t)).toBe(true);
  });

  test("8:59pm is NOT quiet hours (before 9pm boundary)", () => {
    const t = new Date();
    t.setHours(20, 59, 0, 0);
    expect(isQuietHours(t)).toBe(false);
  });

  test("6:31am is NOT quiet hours (after 6:30am end)", () => {
    const t = new Date();
    t.setHours(6, 31, 0, 0);
    expect(isQuietHours(t)).toBe(false);
  });

  test("6:29am IS quiet hours (before 6:30am end)", () => {
    const t = new Date();
    t.setHours(6, 29, 0, 0);
    expect(isQuietHours(t)).toBe(true);
  });

  test("midnight is quiet hours", () => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    expect(isQuietHours(t)).toBe(true);
  });
});

describe("approval tier firing rules", () => {
  test("auto-decide always fires", () => {
    const t3am = new Date();
    t3am.setHours(3, 0, 0, 0);
    expect(canFireApprovalNow("auto-decide", t3am).fire).toBe(true);
    const t11am = new Date();
    t11am.setHours(11, 0, 0, 0);
    expect(canFireApprovalNow("auto-decide", t11am).fire).toBe(true);
  });

  test("morning-batch never fires real-time (defers to morning brief)", () => {
    const t11am = new Date();
    t11am.setHours(11, 0, 0, 0);
    expect(canFireApprovalNow("morning-batch", t11am).fire).toBe(false);
  });

  test("time-critical fires during waking hours", () => {
    const t11am = new Date();
    t11am.setHours(11, 0, 0, 0);
    expect(canFireApprovalNow("time-critical", t11am).fire).toBe(true);
  });

  test("time-critical SUPPRESSED at 3am — gate mistuning signal", () => {
    const t3am = new Date();
    t3am.setHours(3, 0, 0, 0);
    const result = canFireApprovalNow("time-critical", t3am);
    expect(result.fire).toBe(false);
    expect(result.reason).toMatch(/mistuning/i);
  });

  test("hard-blocked never fires", () => {
    const t11am = new Date();
    t11am.setHours(11, 0, 0, 0);
    expect(canFireApprovalNow("hard-blocked", t11am).fire).toBe(false);
  });
});
