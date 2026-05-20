import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  execute as hermesExecute,
  sessionCodec as hermesSessionCodec,
  listSkills as hermesListSkills,
  syncSkills as hermesSyncSkills,
  detectModel as detectModelFromHermes,
} from "hermes-paperclip-adapter/server";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";

export async function executeHermesWrapper(
  ctx: Parameters<typeof hermesExecute>[0],
): Promise<ReturnType<typeof hermesExecute>> {
  return hermesExecute(ctx);
}

export async function testEnvironmentHermesWrapper(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const { testEnvironment } = await import("./hermes-test.js");
  return testEnvironment({
    ...ctx,
    adapterType: "hermes_local",
  });
}

export {
  hermesSessionCodec,
  hermesListSkills,
  hermesSyncSkills,
  detectModelFromHermes,
  hermesAgentConfigurationDoc,
  hermesModels,
};