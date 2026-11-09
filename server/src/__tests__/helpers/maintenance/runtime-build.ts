import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

let ready: Promise<void> | undefined;
export function prepareMaintenanceRuntime() {
  ready ??= (async () => {
    const script = process.env.npm_execpath;
    const javascript = script && /\.[cm]?js$/i.test(script);
    const command = javascript ? process.execPath : script ?? "pnpm";
    const prefix = javascript ? [script!] : [];
    for (const args of [
      ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"],
      ["--filter", "@paperclipai/paperclip-runner", "build:typescript"],
    ]) await promisify(execFile)(command, [...prefix, ...args], {
      cwd: fileURLToPath(new URL("../../../../..", import.meta.url)), env: process.env,
      timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    });
  })();
  return ready;
}
