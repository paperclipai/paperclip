import type { CLIAdapterModule } from "@paperclipai/adapter-utils";
import { printAtomicAgentHttpStdoutEvent } from "./format-event.js";

export const atomicAgentHttpCLIAdapter: CLIAdapterModule = {
  type: "atomic_agent_http",
  formatStdoutEvent: printAtomicAgentHttpStdoutEvent,
};
