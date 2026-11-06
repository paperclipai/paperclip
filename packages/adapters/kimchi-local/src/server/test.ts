import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { resolveKimchiExecutionEngineForRun, testKimchiAcpEnvironment } from "./acp.js";

/**
 * kimchi_local environment checks. The adapter is ACP-only, so this always
 * runs the ACP environment test (which reports an adapter_engine_unavailable
 * error check when ACP prerequisites — Node version, the `kimchi --mode acp`
 * command — are unavailable).
 */
export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const engineSelection = await resolveKimchiExecutionEngineForRun({
    config,
    executionTarget: ctx.executionTarget,
  });
  if (engineSelection.unavailableReason) {
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks: [{
        code: "adapter_engine_unavailable",
        level: "error",
        message: engineSelection.unavailableReason,
      }],
      testedAt: new Date().toISOString(),
    };
  }
  return testKimchiAcpEnvironment(ctx);
}
