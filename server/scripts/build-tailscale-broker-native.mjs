import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  process.stdout.write("[server] skipping Linux Tailscale broker SO_PEERCRED addon build\n");
  process.exit(0);
}

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(serverRoot, "dist", "tailscale-broker");
const source = join(serverRoot, "src", "tailscale-broker", "peercred-native.c");
const output = join(outputDir, "peercred-native.node");
const nodePrefix = process.config.variables.node_prefix;
const headerCandidates = [
  typeof nodePrefix === "string" ? join(nodePrefix, "include", "node") : "",
  resolve(dirname(process.execPath), "..", "include", "node"),
  "/usr/include/node",
  "/usr/local/include/node",
].filter(Boolean);
const headerDir = headerCandidates.find((candidate) => existsSync(join(candidate, "node_api.h")));

if (!headerDir) {
  throw new Error("cannot build Tailscale broker SO_PEERCRED addon: Node.js headers were not found");
}

mkdirSync(outputDir, { recursive: true });
const compiler = process.env.CC || "cc";
const result = spawnSync(
  compiler,
  [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-shared",
    "-fPIC",
    `-I${headerDir}`,
    source,
    "-o",
    output,
  ],
  { stdio: "inherit" },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Tailscale broker SO_PEERCRED addon compiler exited with status ${result.status}`);
}
