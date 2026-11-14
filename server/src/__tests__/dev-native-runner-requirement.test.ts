import { describe, expect, it } from "vitest";
import { nativeRunnerRequiredForDev } from "../lib/dev-native-runner-requirement.js";
import {
  paperclipRunnerBinaryNeedsBuild,
  resolveNativeRunnerRequirement,
} from "../../../scripts/dev-runner-native-binary.mjs";

const defaults = {
  localRunnerSupported: false,
  rolloutEnabled: false,
  dotRolloutEnabled: false,
  persistedNativeRun: false,
};
const flags = [
  { rolloutEnabled: false, dotRolloutEnabled: false },
  { rolloutEnabled: true, dotRolloutEnabled: false },
  { rolloutEnabled: false, dotRolloutEnabled: true },
  { rolloutEnabled: true, dotRolloutEnabled: true },
];
const platforms = ["win32", "linux", "darwin"] as const;
const matrix = platforms.flatMap(platform => flags.map(flag => ({ platform, ...flag })));

describe("native runner development requirements", () => {
  it.each(flags)("does not build a native binary on unsupported idle Windows: %j", flag => {
    const required = nativeRunnerRequiredForDev({ ...defaults, ...flag, platform: "win32" });
    expect(required).toBe(false);
    const status = resolveNativeRunnerRequirement({ exitCode: 0, stdout: JSON.stringify({ nativeRunnerRequired: required }) });
    expect(status).toEqual({ nativeRunnerRequired: false, valid: true });
    expect(paperclipRunnerBinaryNeedsBuild({ repoRoot: "/missing-checkout", configuredBinary: undefined, ...status })).toBe(false);
  });

  it.each(matrix)("preserves persisted native recovery on $platform with flags $rolloutEnabled/$dotRolloutEnabled", option => {
    expect(nativeRunnerRequiredForDev({ ...defaults, ...option, persistedNativeRun: true })).toBe(true);
  });

  it.each(matrix)("prepares a qualified local runtime on $platform with flags $rolloutEnabled/$dotRolloutEnabled", option => {
    expect(nativeRunnerRequiredForDev({ ...defaults, ...option, localRunnerSupported: true })).toBe(true);
  });

  it.each(matrix.filter(option => option.platform !== "win32"))("preserves Unix opt-in on $platform with flags $rolloutEnabled/$dotRolloutEnabled", option => {
    expect(nativeRunnerRequiredForDev({ ...defaults, ...option })).toBe(option.rolloutEnabled || option.dotRolloutEnabled);
  });

  it("uses the actual host platform when no platform override is provided", () => {
    expect(nativeRunnerRequiredForDev({ ...defaults, rolloutEnabled: true })).toBe(process.platform !== "win32");
  });

  it.each([
    { exitCode: 1, stdout: '{"nativeRunnerRequired":false}' },
    { exitCode: 0, stdout: "not JSON" },
    { exitCode: 0, stdout: '{"nativeRunnerRequired":"false"}' },
  ])("keeps the conservative requirement when the status probe fails: %j", result => {
    expect(resolveNativeRunnerRequirement(result)).toEqual({ nativeRunnerRequired: true, valid: false });
  });
});
