import { describe, expect, it } from "vitest";
import {
  createRoutineSuggestionSchema,
  routineSuggestionCadenceLabel,
  routineSuggestionCronExpression,
  type RoutineSuggestionCadence,
} from "./routine-suggestions.js";

describe("routine suggestion cadence", () => {
  const cases: Array<[RoutineSuggestionCadence, string, string]> = [
    [{ frequency: "daily", time: "08:30" }, "30 8 * * *", "Every day at 8:30 AM"],
    [{ frequency: "weekdays", time: "17:00" }, "0 17 * * 1-5", "Every weekday at 5 PM"],
    [{ frequency: "weekly", dayOfWeek: "monday", time: "09:00" }, "0 9 * * 1", "Every Monday at 9 AM"],
    [{ frequency: "weekly", dayOfWeek: "sunday", time: "00:05" }, "5 0 * * 0", "Every Sunday at 12:05 AM"],
    [{ frequency: "monthly", dayOfMonth: 1, time: "12:00" }, "0 12 1 * *", "On the 1st of every month at 12 PM"],
    [{ frequency: "monthly", dayOfMonth: 22, time: "10:15" }, "15 10 22 * *", "On the 22nd of every month at 10:15 AM"],
    [{ frequency: "monthly", dayOfMonth: 13, time: "07:00" }, "0 7 13 * *", "On the 13th of every month at 7 AM"],
  ];

  it.each(cases)("derives the schedule and plain words for %o", (cadence, cron, label) => {
    expect(routineSuggestionCronExpression(cadence)).toBe(cron);
    expect(routineSuggestionCadenceLabel(cadence)).toBe(label);
  });

  it("requires the day a weekly or monthly cadence runs on", () => {
    const base = { title: "Weekly report", instructions: "Write it." };
    expect(createRoutineSuggestionSchema.safeParse({ ...base, cadence: { frequency: "weekly", time: "09:00" } }).success).toBe(false);
    expect(createRoutineSuggestionSchema.safeParse({ ...base, cadence: { frequency: "monthly", time: "09:00" } }).success).toBe(false);
    expect(createRoutineSuggestionSchema.safeParse({ ...base, cadence: { frequency: "monthly", dayOfMonth: 29, time: "09:00" } }).success).toBe(false);
    expect(createRoutineSuggestionSchema.safeParse({ ...base, cadence: { frequency: "daily", time: "9:00" } }).success).toBe(false);
    expect(createRoutineSuggestionSchema.safeParse({ ...base, cadence: { frequency: "daily", time: "09:00" } }).success).toBe(true);
  });
});
