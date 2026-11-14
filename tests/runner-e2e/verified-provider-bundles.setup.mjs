import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const builder = fileURLToPath(new URL("../../packages/paperclip-runner/scripts/build-verified-provider-entrypoints.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [builder], { cwd: root, stdio: "inherit" });
  if (result.error) throw new Error("Runner E2E provider bundle preparation failed", { cause: result.error });
  if (result.signal || result.status !== 0) {
    throw new Error(`Runner E2E provider bundle preparation failed: ${result.signal ?? `exit ${result.status}`}`);
  }
}
