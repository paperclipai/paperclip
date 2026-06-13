import type { PaperclipConfig } from "../config/schema.js";
import { checkPort } from "../utils/net.js";
import type { CheckResult } from "./index.js";

export async function portCheck(config: PaperclipConfig): Promise<CheckResult> {
  const { host, port } = config.server;
  const result = await checkPort(port, host);

  if (result.available) {
    return {
      name: "Server port",
      status: "pass",
      message: `Port ${port} is available on ${host}`,
    };
  }

  return {
    name: "Server port",
    status: "warn",
    message: result.error ?? `Port ${port} is not available on ${host}`,
    canRepair: false,
    repairHint: `Check what's using ${host}:${port} with: lsof -i @${host}:${port}`,
  };
}
