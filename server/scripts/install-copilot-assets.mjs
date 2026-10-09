import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const installer = new URL("../dist/install-copilot-assets.mjs", import.meta.url);
try {
  await access(fileURLToPath(installer));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  // Dependencies install before compilation in a source workspace. Published
  // server packages omit src and cannot take this bootstrap exception.
  await access(fileURLToPath(new URL("../src/services/copilot-connection-probe.ts", import.meta.url)));
  await access(fileURLToPath(new URL("../../pnpm-workspace.yaml", import.meta.url)));
  process.stdout.write("Copilot runtime assets: source-workspace-pending-build\n");
  process.exit(0);
}
const { installCopilotAssets } = await import(installer.href);
const result = await installCopilotAssets();
process.stdout.write(`Copilot runtime assets: ${result.status} (${result.target})\n`);
