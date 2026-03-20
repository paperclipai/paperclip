import type { CLIAdapterModule } from "@paperclipai/adapter-utils";
import { type } from "../index.js";
import { formatStdoutEvent } from "./format-event.js";

export { formatStdoutEvent };

export const kiroLocalCLIAdapter: CLIAdapterModule = {
  type,
  formatStdoutEvent,
};
