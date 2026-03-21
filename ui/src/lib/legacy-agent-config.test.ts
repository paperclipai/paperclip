import { describe, expect, it } from "vitest";
import {
  hasLegacyWorkingDirectory,
  shouldShowLegacyWorkingDirectoryField,
} from "./legacy-agent-config";

describe("legacy agent config helpers", () => {
  it("treats non-empty cwd values as legacy working directories", () => {
    expect(hasLegacyWorkingDirectory("/tmp/workspace")).toBe(true);
    expect(hasLegacyWorkingDirectory("  /tmp/workspace  ")).toBe(true);
  });

  it("ignores nullish and blank cwd values", () => {
    expect(hasLegacyWorkingDirectory("")).toBe(false);
    expect(hasLegacyWorkingDirectory("   ")).toBe(false);
    expect(hasLegacyWorkingDirectory(null)).toBe(false);
    expect(hasLegacyWorkingDirectory(undefined)).toBe(false);
  });

  it("shows the deprecated field only for edit forms with an existing cwd", () => {
    expect(
      shouldShowLegacyWorkingDirectoryField({
        isCreate: true,
        adapterConfig: { cwd: "/tmp/workspace" },
      }),
    ).toBe(false);
    expect(
      shouldShowLegacyWorkingDirectoryField({
        isCreate: false,
        adapterConfig: { cwd: "" },
      }),
    ).toBe(false);
    expect(
      shouldShowLegacyWorkingDirectoryField({
        isCreate: false,
        adapterConfig: { cwd: "/tmp/workspace" },
      }),
    ).toBe(true);
  });
});
