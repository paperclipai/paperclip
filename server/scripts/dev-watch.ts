import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveServerDevWatchIgnorePaths } from "../src/dev-watch-ignore.ts";

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoreArgs = resolveServerDevWatchIgnorePaths(serverRoot).flatMap((ignorePath) => ["--exclude", ignorePath]);

const child = spawn(
  process.execPath,
  [tsxCliPath, "watch", ...ignoreArgs, "src/index.ts"],
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
