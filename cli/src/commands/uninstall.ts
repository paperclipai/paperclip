import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import {
  assertManagedInstallStore,
  removeManagedPathBlock,
  removeManagedShim,
  resolveInstallStorePaths,
  withInstallStoreLock,
} from "../install-store.js";
import { resolvePaperclipInstanceId } from "../config/home.js";
import { detectServiceManager, systemdServiceName } from "../services/service-manager.js";

type UninstallDependencies = {
  detectServiceManager: typeof detectServiceManager;
  platform: NodeJS.Platform;
  userHomeDir: string;
};

export async function uninstallCommand(
  dependencies: Partial<UninstallDependencies> = {},
): Promise<void> {
  const instanceId = resolvePaperclipInstanceId();
  const detect = dependencies.detectServiceManager ?? detectServiceManager;
  const platform = dependencies.platform ?? process.platform;
  const userHomeDir = dependencies.userHomeDir ?? os.homedir();
  const detection = await detect({ instanceId, platform });
  if (!detection.supported && platform === "linux") {
    const definitionPath = path.join(
      userHomeDir,
      ".config",
      "systemd",
      "user",
      systemdServiceName(instanceId),
    );
    if (fs.existsSync(definitionPath)) {
      throw new Error(
        `Cannot verify or remove the background service: ${detection.reason}. Retry when the service manager is available.`,
      );
    }
  }
  if (detection.supported) {
    const status = await detection.manager.status();
    if (status.installed || status.active) await detection.manager.uninstall();
  }

  const paths = resolveInstallStorePaths();
  const hadStore = fs.existsSync(paths.cliRoot);
  if (hadStore) assertManagedInstallStore(paths);
  const shimRemoved = await withInstallStoreLock(async () => {
    if (hadStore) assertManagedInstallStore(paths);
    const removed = removeManagedShim(paths);

    const home = process.env.HOME;
    for (const rcFile of home ? [path.join(home, ".bashrc"), path.join(home, ".zshrc")] : []) {
      removeManagedPathBlock(rcFile);
    }
    fs.rmSync(paths.cliRoot, { recursive: true, force: true });
    return removed;
  }, paths, { initialize: !hadStore });

  if (!shimRemoved) {
    console.log(pc.yellow(`Left ${paths.shimPath} unchanged because it is not a Paperclip-managed shim.`));
  }
  console.log(pc.green("Removed the managed Paperclip CLI install."));
  console.log(pc.dim(`User data was left untouched under ${paths.paperclipHome}.`));
}
