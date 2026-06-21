import { describe, expect, it } from "vitest";
import { parseCronToPreset } from "./ScheduleEditor";

describe("parseCronToPreset", () => {
  it("classifies */15 * * * * as custom (not every_hour)", () => {
    expect(parseCronToPreset("*/15 * * * *").preset).toBe("custom");
  });

  it("classifies 0 * * * * as every_hour", () => {
    expect(parseCronToPreset("0 * * * *").preset).toBe("every_hour");
  });

  it("classifies 30 * * * * as every_hour", () => {
    expect(parseCronToPreset("30 * * * *").preset).toBe("every_hour");
  });

  it("classifies 0 */6 * * * as custom (step in hr)", () => {
    expect(parseCronToPreset("0 */6 * * *").preset).toBe("custom");
  });

  it("classifies 0 10 * * * as every_day", () => {
    expect(parseCronToPreset("0 10 * * *").preset).toBe("every_day");
  });

  it("classifies * * * * * as every_minute", () => {
    expect(parseCronToPreset("* * * * *").preset).toBe("every_minute");
  });

  it("classifies 0 10 * * 1-5 as weekdays", () => {
    expect(parseCronToPreset("0 10 * * 1-5").preset).toBe("weekdays");
  });

  it("classifies 0 10 * * 3 as weekly", () => {
    expect(parseCronToPreset("0 10 * * 3").preset).toBe("weekly");
  });

  it("classifies 0 10 15 * * as monthly", () => {
    expect(parseCronToPreset("0 10 15 * *").preset).toBe("monthly");
  });

  it("classifies 5-10 * * * * as custom (range in min)", () => {
    expect(parseCronToPreset("5-10 * * * *").preset).toBe("custom");
  });

  it("classifies 0,15,30,45 * * * * as custom (list in min)", () => {
    expect(parseCronToPreset("0,15,30,45 * * * *").preset).toBe("custom");
  });

  it("classifies */2 */2 * * * as custom (step in both min and hr)", () => {
    expect(parseCronToPreset("*/2 */2 * * *").preset).toBe("custom");
  });
});
