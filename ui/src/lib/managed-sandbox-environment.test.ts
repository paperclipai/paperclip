import { describe, expect, it } from "vitest";
import {
  environmentDisplayLabel,
  filterManagedSandboxSelectableEnvironments,
  isPlatformManagedEnvironment,
} from "./managed-sandbox-environment";

describe("managed sandbox environment helpers", () => {
  it("identifies platform-managed rows by the provisioner marker", () => {
    expect(isPlatformManagedEnvironment({ metadata: { managedByPaperclip: true } })).toBe(true);
    expect(isPlatformManagedEnvironment({ metadata: { managedByPaperclip: false } })).toBe(false);
    expect(isPlatformManagedEnvironment({ metadata: { source: "manual" } })).toBe(false);
    expect(isPlatformManagedEnvironment({ metadata: null })).toBe(false);
    expect(isPlatformManagedEnvironment(null)).toBe(false);
  });

  it("labels platform-managed rows by name alone and keeps the driver suffix elsewhere", () => {
    expect(
      environmentDisplayLabel({
        name: "Paperclip Computer",
        driver: "sandbox",
        metadata: { managedByPaperclip: true },
      }),
    ).toBe("Paperclip Computer");
    expect(
      environmentDisplayLabel({ name: "E2B", driver: "sandbox", metadata: null }),
    ).toBe("E2B · sandbox");
    expect(
      environmentDisplayLabel({ name: "Build box", driver: "ssh", metadata: {} }),
    ).toBe("Build box · ssh");
  });

  it("filters the local environment only under managed-sandbox-only", () => {
    const environments = [
      { driver: "local" as const },
      { driver: "sandbox" as const },
      { driver: "ssh" as const },
    ];
    expect(filterManagedSandboxSelectableEnvironments(environments, true)).toEqual([
      { driver: "sandbox" },
      { driver: "ssh" },
    ]);
    expect(filterManagedSandboxSelectableEnvironments(environments, false)).toEqual(environments);
  });
});
