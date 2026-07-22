import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import {
  assertManagedInstallStore,
  removeManagedPathBlock,
  removeManagedShim,
  resolveInstallStorePaths,
  withInstallStoreLock,
} from "../install-store.js";

export async function uninstallCommand(): Promise<void> {
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
