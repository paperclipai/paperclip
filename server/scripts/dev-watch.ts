import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveServerDevWatchIgnorePaths } from "../src/dev-watch-ignore.ts";

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoreArgs = resolveServerDevWatchIgnorePaths(serverRoot).flatMap((ignorePath) => ["--exclude", ignorePath]);

// Let tsx own this process and its shutdown lifecycle. A separate wrapper can
// orphan the watcher on exit; forwarding group signals can instead deliver them
// twice and make tsx force-kill the server before it finishes cleanup.
process.chdir(serverRoot);
process.argv = [process.execPath, tsxCliPath, "watch", ...ignoreArgs, "src/index.ts"];
await import(pathToFileURL(tsxCliPath).href);
