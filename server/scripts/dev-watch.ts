import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveServerDevWatchIgnorePaths } from "../src/dev-watch-ignore.ts";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Keep resolving the ignore list here so the watched-path contract remains
// visible to maintainers even though Node's built-in watch mode cannot apply
// the excludes directly the way `tsx watch` did.
resolveServerDevWatchIgnorePaths(serverRoot);

const child = spawn(
  process.execPath,
  ["--watch", "--watch-preserve-output", "--import", "tsx", "src/index.ts"],
  {
    cwd: serverRoot,
    env: process.env,
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
