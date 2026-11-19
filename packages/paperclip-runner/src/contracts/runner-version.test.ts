import { describe, expect, it } from "vitest";
import { runnerVersionCanResume } from "./runner-version.js";

describe("runnerVersionCanResume", () => {
  it.each([
    ["0.4.0", "0.4.0", true],
    ["0.4.1", "0.4.0", true],
    ["0.5.0", "0.4.9", true],
    ["1.0.0", "0.9.9", true],
    ["0.4.0", "0.4.1", false],
    ["0.10.0", "0.9.0", true],
    ["0.4.0", "0.4.0-rc.1", true],
    ["0.4.0-rc.1", "0.4.0", false],
    ["0.4.0-rc.2", "0.4.0-rc.1", true],
    ["0.4.0-rc.10", "0.4.0-rc.9", true],
    ["0.4.0-rc.1", "0.4.0-rc.1.1", false],
    ["0.4.0-rc.1.1", "0.4.0-rc.1", true],
    ["0.4.0-beta", "0.4.0-alpha", true],
    ["0.4.0-1", "0.4.0-alpha", false],
    ["0.4.0+build.2", "0.4.0+build.1", true],
    ["0.4.0-01", "0.4.0", false],
    ["not-a-version", "0.4.0", false],
    ["0.4.0", "", false],
  ])("%s resumes %s: %s", (current, previous, expected) => {
    expect(runnerVersionCanResume(current, previous)).toBe(expected);
  });
});
