import type { UIAdapterModule } from "../types";
import { parseAtomicAgentHttpStdoutLine } from "./parse-stdout";
import { AtomicAgentHttpConfigFields } from "./config-fields";
import { buildAtomicAgentHttpConfig } from "./build-config";

export const atomicAgentHttpUIAdapter: UIAdapterModule = {
  type: "atomic_agent_http",
  label: "Atomic Agent (HTTP)",
  parseStdoutLine: parseAtomicAgentHttpStdoutLine,
  ConfigFields: AtomicAgentHttpConfigFields,
  buildAdapterConfig: buildAtomicAgentHttpConfig,
};
