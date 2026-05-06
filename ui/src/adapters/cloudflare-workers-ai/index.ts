import type { UIAdapterModule } from "../types";
import { parseHttpStdoutLine } from "../http/parse-stdout";
import { CloudflareWorkersAiConfigFields } from "./config-fields";
import { buildCloudflareWorkersAiConfig } from "./build-config";

export const cloudflareWorkersAiUIAdapter: UIAdapterModule = {
  type: "cloudflare_workers_ai",
  label: "Cloudflare Workers AI",
  parseStdoutLine: parseHttpStdoutLine,
  ConfigFields: CloudflareWorkersAiConfigFields,
  buildAdapterConfig: buildCloudflareWorkersAiConfig,
};
