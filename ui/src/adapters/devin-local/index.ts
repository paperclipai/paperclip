import type { UIAdapterModule } from "../types";
import {
  parseDevinStdoutLine,
  buildDevinLocalConfig,
} from "@paperclipai/adapter-devin-local/ui";
import { DevinLocalConfigFields } from "./config-fields";

export const devinLocalUIAdapter: UIAdapterModule = {
  type: "devin_local",
  label: "Devin",
  parseStdoutLine: parseDevinStdoutLine,
  ConfigFields: DevinLocalConfigFields,
  buildAdapterConfig: buildDevinLocalConfig,
};
