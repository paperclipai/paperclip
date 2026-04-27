import { asBoolean } from "@paperclipai/adapter-utils/server-utils";

type PreparedOpenHandsRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

export async function prepareOpenHandsRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
}): Promise<PreparedOpenHandsRuntimeConfig> {
  // OpenHands uses --override-with-envs flag which prevents it from writing
  // settings files, so we don't need to inject runtime config like OpenCode does.
  // We only need to return the environment variables and a no-op cleanup.
  return {
    env: input.env,
    notes: [
      "OpenHands is running with --override-with-envs to prevent settings file writing.",
    ],
    cleanup: async () => {},
  };
}
