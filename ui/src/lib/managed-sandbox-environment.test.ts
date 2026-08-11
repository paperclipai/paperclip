import { describe, expect, it } from "vitest";
import {
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
