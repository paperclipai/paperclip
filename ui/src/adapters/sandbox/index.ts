import type { UIAdapterModule } from "../types";
import { parseSandboxStdoutLine, buildSandboxConfig } from "@paperclipai/adapter-sandbox/ui";
import { SandboxConfigFields } from "./config-fields";

export const sandboxUIAdapter: UIAdapterModule = {
  type: "sandbox",
  label: "Sandboxed Agent",
  parseStdoutLine: parseSandboxStdoutLine,
  ConfigFields: SandboxConfigFields,
  buildAdapterConfig: buildSandboxConfig,
};
