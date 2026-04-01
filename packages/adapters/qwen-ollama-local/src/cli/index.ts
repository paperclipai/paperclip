import type { CLIAdapterModule } from "@paperclipai/adapter-utils";
import pc from "picocolors";
import * as metadata from "../index.js";

function formatStdoutEvent(line: string, debug: boolean): void {
  if (line.startsWith("[ollama]")) {
    const message = line.replace("[ollama]", "").trim();
    console.log(pc.gray(`[ollama] ${pc.cyan(message)}`));
  } else if (line.startsWith("ERROR") || line.startsWith("Error")) {
    console.log(pc.red(line));
  } else {
    console.log(line);
  }
}

export const module: CLIAdapterModule = {
  type: metadata.type,
  formatStdoutEvent,
};

export default module;
