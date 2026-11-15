import type { UIAdapterModule } from "../types";
import {
  buildDistillLocalConfig,
  createDistillStdoutParser,
  parseDistillStdoutLine,
} from "@paperclipai/adapter-distill-local/ui";
import { DistillLocalConfigFields } from "./config-fields";

export const distillLocalUIAdapter: UIAdapterModule = {
  type: "distill_local",
  label: "Distill",
  parseStdoutLine: parseDistillStdoutLine,
  createStdoutParser: createDistillStdoutParser,
  ConfigFields: DistillLocalConfigFields,
  buildAdapterConfig: buildDistillLocalConfig,
};
