import { describe, expect, it } from "vitest";
import { getEnvironmentCapabilities } from "@paperclipai/shared";
import { getSandboxProvider } from "../services/sandbox-provider-runtime.ts";

// The execution guard in environment-runtime.ts admits a reusable lease only
// when the provider declares supportsReusableLeases === true. This helper
// mirrors that guard, so the tests can compare the presentation default with
// the execution decision.
function executionSupportsReusableLeases(declared: boolean | undefined): boolean {
  return declared === true;
}

describe("reusable leases default", () => {
  it("test_fake_provider_reusable_leases_matches_runtime_declaration", () => {
    const fakeRuntime = getSandboxProvider("fake");
    expect(fakeRuntime).not.toBeNull();
    expect(fakeRuntime?.supportsReusableLeases).toBe(false);

    const capabilities = getEnvironmentCapabilities(["codex_local"]);
    expect(capabilities.sandboxProviders.fake.supportsReusableLeases).toBe(
      fakeRuntime?.supportsReusableLeases ?? false,
    );
  });

  it("test_api_presentation_agrees_with_runtime_execution_for_reusable_leases", () => {
    // Built-in fake provider: the runtime declares false, so execution and
    // presentation both resolve to false.
    const fakeRuntime = getSandboxProvider("fake");
    const builtin = getEnvironmentCapabilities(["codex_local"]);
    expect(builtin.sandboxProviders.fake.supportsReusableLeases).toBe(
      executionSupportsReusableLeases(fakeRuntime?.supportsReusableLeases),
    );

    // Plug-in provider whose manifest does not declare reusable leases.
    const absent = getEnvironmentCapabilities(["codex_local"], {
      sandboxProviders: { "no-reuse-plugin": { displayName: "No Reuse" } },
    });
    expect(absent.sandboxProviders["no-reuse-plugin"].supportsReusableLeases).toBe(
      executionSupportsReusableLeases(undefined),
    );

    // Plug-in provider whose manifest declares reusable leases.
    const declared = getEnvironmentCapabilities(["codex_local"], {
      sandboxProviders: {
        "reuse-plugin": { displayName: "Reuse", supportsReusableLeases: true },
      },
    });
    expect(declared.sandboxProviders["reuse-plugin"].supportsReusableLeases).toBe(
      executionSupportsReusableLeases(true),
    );
  });
});
