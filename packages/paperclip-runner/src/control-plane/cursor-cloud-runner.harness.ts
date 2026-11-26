import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { copyOwnedNodeRuntime } from "../test-support/owned-node-runtime.js";

export async function privateCloudNodeCommand(root: string): Promise<string> {
  const directory = join(root, "provider-node");
  await mkdir(directory, { mode: 0o700 });
  const { executable } = await copyOwnedNodeRuntime(directory);
  // Keep Node's name so the verified launcher selects its descriptor loader.
  const command = join(directory, process.platform === "win32" ? "node.exe" : "node");
  await rename(executable, command);
  return command;
}

export function buildPrivateCursorCloudProxy(proxyPath: string): void {
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const builderUrl = new URL("../../scripts/build-verified-provider-entrypoints.mjs", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", [
    "import { writeFile } from 'node:fs/promises';",
    `const { bundleVerifiedProviderEntrypoints } = await import(${JSON.stringify(builderUrl)});`,
    "const item = (await bundleVerifiedProviderEntrypoints({ write: false })).find(value => value.entrypoint.name === 'cursor-cloud-app-server-proxy');",
    `await writeFile(${JSON.stringify(proxyPath)}, item.verifiedResult.outputFiles[0].contents, { mode: 0o600 });`,
  ].join("\n")], { cwd: packageRoot, timeout: 20_000, stdio: "pipe" });
}

export async function currentCloudScopeHeader(runtime: string, sessionId: string): Promise<string> {
  const name = `checkpoint-${createHash("sha256").update(sessionId).digest("hex")}.json`;
  const checkpoint = JSON.parse(await readFile(join(runtime, name), "utf8"));
  expect(checkpoint.relayTurnToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return `Bearer ${checkpoint.relayTurnToken}`;
}
