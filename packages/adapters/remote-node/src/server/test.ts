import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";
import { parseObject, asString } from "@paperclipai/adapter-utils/server-utils";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const nodeId = asString(config.nodeId, "");

  if (!nodeId) {
    checks.push({
      code: "node_id_missing",
      level: "error",
      message: "No nodeId configured",
      hint: "Set nodeId in adapterConfig to the UUID of a registered remote node.",
    });
    return {
      adapterType: "remote_node",
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push({
    code: "node_id_set",
    level: "info",
    message: `Node ID: ${nodeId}`,
    detail: "Node reachability is checked at run time when the runner claims work.",
  });

  return {
    adapterType: "remote_node",
    status: "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
