import type { UIAdapterModule } from "./types";
import { claudeLocalUIAdapter } from "./claude-local";
import { codexLocalUIAdapter } from "./codex-local";
import { openClawUIAdapter } from "./openclaw";
import { piLocalUIAdapter } from "./pi-local";
import { processUIAdapter } from "./process";
import { httpUIAdapter } from "./http";

const adaptersByType = new Map<string, UIAdapterModule>(
  [claudeLocalUIAdapter, codexLocalUIAdapter, openClawUIAdapter, piLocalUIAdapter, processUIAdapter, httpUIAdapter].map((a) => [a.type, a]),
);

export function getUIAdapter(type: string): UIAdapterModule {
  return adaptersByType.get(type) ?? processUIAdapter;
}
