import { describe, expect, it } from "vitest";
import { parseDurationMs } from "../commands/client/routine-api.js";

describe("parseDurationMs", () => {
  it("parses each unit", () => {
    expect(parseDurationMs("90s")).toBe(90_000);
    expect(parseDurationMs("15m")).toBe(900_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
  });

  it("treats a bare number as seconds", () => {
    expect(parseDurationMs("30")).toBe(30_000);
  });

  it("rejects malformed durations", () => {
    expect(() => parseDurationMs("soon")).toThrow(/Invalid duration/);
    expect(() => parseDurationMs("5x")).toThrow(/Invalid duration/);
    expect(() => parseDurationMs("")).toThrow(/Invalid duration/);
  });
});
