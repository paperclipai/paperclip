import type { UIAdapterModule } from "../types";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { PicoClawConfigFields } from "./config-fields";
import { buildPicoClawConfig } from "./build-config";

function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}

export const picoClawLocalUIAdapter: UIAdapterModule = {
  type: "picoclaw_local",
  label: "PicoClaw (local)",
  parseStdoutLine,
  ConfigFields: PicoClawConfigFields,
  buildAdapterConfig: buildPicoClawConfig,
};
