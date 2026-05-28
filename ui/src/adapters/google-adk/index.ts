import type { UIAdapterModule } from "../types";
import { parseGoogleAdkStdoutLine, buildGoogleAdkConfig } from "@paperclipai/adapter-google-adk/ui";
import { GoogleAdkConfigFields } from "./config-fields";

export const googleAdkUIAdapter: UIAdapterModule = {
  type: "google_adk",
  label: "Google ADK",
  parseStdoutLine: parseGoogleAdkStdoutLine,
  ConfigFields: GoogleAdkConfigFields,
  buildAdapterConfig: buildGoogleAdkConfig,
};
