import { agentHarnessType, paperclipRunnerSupportsPlatform } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { localAgentRunnerTarget } from "../lib/agent-runner-platform.js";
import { unprocessable } from "../errors.js";
import { resolveAgentRunnerEnvironmentForCompany } from "./agent-runner-selection.js";

export async function resolvePoolExecutionPlatform(db: Db, companyId: string, environmentId: string | null | undefined) {
  if (environmentId === undefined) return null;
  const { driver } = await resolveAgentRunnerEnvironmentForCompany(db, companyId, environmentId);
  return driver === "local" ? localAgentRunnerTarget() : null;
}

export function assertPoolExecutionPlatform(
  target: ReturnType<typeof localAgentRunnerTarget> | null,
  adapterType: string,
  config: Record<string, unknown>,
) {
  if (!target || adapterType !== "paperclip_runner") return;
  const harness = agentHarnessType(adapterType, config);
  if (!paperclipRunnerSupportsPlatform(harness, target.platform, target.architecture, target.libc, target.glibcVersion)) {
    throw unprocessable("This pool harness is unavailable on the selected execution platform. Choose a supported pool account or environment.", {
      code: "pool_execution_platform_incompatible", harness, platform: target.platform, architecture: target.architecture,
    });
  }
}
