import { t } from "@/i18n";
import type { UIAdapterModule } from "../types";
import { parseKimiStdoutLine } from "@paperclipai/adapter-kimi-local/ui";
import { KimiLocalConfigFields } from "./config-fields";
import { buildKimiLocalConfig } from "@paperclipai/adapter-kimi-local/ui";

export const kimiLocalUIAdapter: UIAdapterModule = {
  type: "kimi_local",
  get label() { return t("agent-config:kimiCode_e4e5d37"); },
  parseStdoutLine: parseKimiStdoutLine,
  ConfigFields: KimiLocalConfigFields,
  buildAdapterConfig: buildKimiLocalConfig,
  // Kimi streams token-level deltas (~16k per run, ~50x a comparable Claude
  // run): keep a wide transcript window so heartbeats don't drop rendered
  // content mid-run, and render live reasoning as a scrollable log instead of
  // the one-line ticker.
  transcriptPresentation: {
    maxVisibleEntries: 400,
    liveReasoningView: "scrollLog",
  },
};
