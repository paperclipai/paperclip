import { t } from "@/i18n";
import type { UIAdapterModule } from "../types";
import { parseHttpStdoutLine } from "./parse-stdout";
import { HttpConfigFields } from "./config-fields";
import { buildHttpConfig } from "./build-config";

export const httpUIAdapter: UIAdapterModule = {
  type: "http",
  get label() { return t("agent-config:httpWebhook_9461cef"); },
  parseStdoutLine: parseHttpStdoutLine,
  ConfigFields: HttpConfigFields,
  buildAdapterConfig: buildHttpConfig,
};
