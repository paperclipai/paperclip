import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import {
  assertManagedInstallStore,
  removeManagedPathBlock,
  removeManagedShim,
  resolveInstallStorePaths,
} from "../install-store.js";
import { resolvePaperclipInstanceId } from "../config/home.js";
import { detectServiceManager } from "../services/service-manager.js";

type UninstallDependencies = {
  detectServiceManager: typeof detectServiceManager;
};

export async function uninstallCommand(
  dependencies: Partial<UninstallDependencies> = {},
): Promise<void> {
  const detect = dependencies.detectServiceManager ?? detectServiceManager;
  const detection = await detect({ instanceId: resolvePaperclipInstanceId() });
  if (detection.supported) {
    const status = await detection.manager.status();
    if (status.installed || status.active) await detection.manager.uninstall();
  }

  const paths = resolveInstallStorePaths();
  if (fs.existsSync(paths.cliRoot)) assertManagedInstallStore(paths);
  const shimRemoved = removeManagedShim(paths);
  fs.rmSync(paths.cliRoot, { recursive: true, force: true });

  const home = process.env.HOME;
  for (const rcFile of home ? [path.join(home, ".bashrc"), path.join(home, ".zshrc")] : []) {
    removeManagedPathBlock(rcFile);
  }

  if (!shimRemoved) {
    console.log(pc.yellow(`Left ${paths.shimPath} unchanged because it is not a Paperclip-managed shim.`));
  }
  console.log(pc.green("Removed the managed Paperclip CLI install."));
  console.log(pc.dim(`User data was left untouched under ${paths.paperclipHome}.`));
}
