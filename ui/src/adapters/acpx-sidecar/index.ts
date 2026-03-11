import type { UIAdapterModule } from "../types";
import { parseAcpxSidecarStdoutLine, buildAcpxSidecarConfig } from "@paperclipai/adapter-acpx-sidecar/ui";
import { AcpxSidecarConfigFields } from "./config-fields";

export const acpxSidecarUIAdapter: UIAdapterModule = {
  type: "acpx_sidecar",
  label: "ACPX Sidecar",
  parseStdoutLine: parseAcpxSidecarStdoutLine,
  ConfigFields: AcpxSidecarConfigFields,
  buildAdapterConfig: buildAcpxSidecarConfig,
};
