import type { UIAdapterModule } from "./types";
import { claudeLocalUIAdapter } from "./claude-local";
import { codexLocalUIAdapter } from "./codex-local";
import { cursorLocalUIAdapter } from "./cursor";
import { geminiLocalUIAdapter } from "./gemini-local";
import { openCodeLocalUIAdapter } from "./opencode-local";
import { piLocalUIAdapter } from "./pi-local";
import { openClawGatewayUIAdapter } from "./openclaw-gateway";
import { processUIAdapter } from "./process";
import { httpUIAdapter } from "./http";

/** Cloud sandbox adapter — config is handled by CloudSandboxFields in AgentConfigForm */
const cloudSandboxUIAdapter: UIAdapterModule = {
  type: "cloud_sandbox",
  label: "Cloud Sandbox",
  parseStdoutLine: (_line, _ts) => [],
  ConfigFields: () => null,
  buildAdapterConfig: (values) => ({
    runtime: values.runtime ?? "claude",
    model: values.model || undefined,
  }),
};

const uiAdapters: UIAdapterModule[] = [
  claudeLocalUIAdapter,
  codexLocalUIAdapter,
  geminiLocalUIAdapter,
  openCodeLocalUIAdapter,
  piLocalUIAdapter,
  cursorLocalUIAdapter,
  openClawGatewayUIAdapter,
  cloudSandboxUIAdapter,
  processUIAdapter,
  httpUIAdapter,
];

const adaptersByType = new Map<string, UIAdapterModule>(
  uiAdapters.map((a) => [a.type, a]),
);

export function getUIAdapter(type: string): UIAdapterModule {
  return adaptersByType.get(type) ?? processUIAdapter;
}

export function listUIAdapters(): UIAdapterModule[] {
  return [...uiAdapters];
}
