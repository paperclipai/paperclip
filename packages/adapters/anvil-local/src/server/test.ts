import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  return {
    adapterType: "anvil_local",
    status: "pass",
    checks: [],
    testedAt: new Date().toISOString(),
  };
}
