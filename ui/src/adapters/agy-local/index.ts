import type { AdapterConfigFieldsProps, CreateConfigValues, UIAdapterModule } from "../types";
import { parseGeminiStdoutLine } from "@paperclipai/adapter-gemini-local/ui";
import { GeminiLocalConfigFields } from "../gemini-local/config-fields";

const AGY_MODEL = "gemini-3.5-flash";

function buildAgyLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {
    model: AGY_MODEL,
    timeoutSec: 0,
    graceSec: 15,
    sandbox: !v.dangerouslyBypassSandbox,
    dangerouslySkipPermissions: true,
  };
  if (v.cwd) config.cwd = v.cwd;
  if (v.instructionsFilePath) config.instructionsFilePath = v.instructionsFilePath;
  if (v.command) config.command = v.command;
  if (v.extraArgs) {
    config.extraArgs = v.extraArgs
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return config;
}

function AgyLocalConfigFields(props: AdapterConfigFieldsProps) {
  return GeminiLocalConfigFields({ ...props, promptName: "Antigravity" });
}

export const agyLocalUIAdapter: UIAdapterModule = {
  type: "agy_local",
  label: "Antigravity CLI (local)",
  parseStdoutLine: parseGeminiStdoutLine,
  ConfigFields: AgyLocalConfigFields,
  buildAdapterConfig: buildAgyLocalConfig,
};
