import type { UIAdapterModule } from "../types";
import { parseBastionclawStdoutLine } from "@paperclipai/adapter-bastionclaw/ui";
import { buildBastionclawConfig } from "@paperclipai/adapter-bastionclaw/ui";
import { BastionclawConfigFields } from "./config-fields";

export const bastionclawUIAdapter: UIAdapterModule = {
  type: "bastionclaw_gateway",
  label: "BastionClaw Gateway",
  parseStdoutLine: parseBastionclawStdoutLine,
  ConfigFields: BastionclawConfigFields,
  buildAdapterConfig: buildBastionclawConfig,
};
