import type { CLIAdapterModule } from "@paperclipai/adapter-utils";
import { printCopilotStreamEvent } from "./format-event.js";

export const copilotLocalCLIAdapter: CLIAdapterModule = {
  type: "copilot_local",
  formatStdoutEvent: printCopilotStreamEvent,
};
