import { existsSync, cpSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolvePnpmInvocation } from "../server/scripts/prepare-runner-vendor.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiDist = resolve(repoRoot, "ui", "dist");
const serverUiDist = resolve(repoRoot, "server", "ui-dist");

const reuseEnv = (process.env.PAPERCLIP_RELEASE_REUSE_UI_DIST ?? "").toLowerCase();
const shouldReuse = ["1", "true", "yes"].includes(reuseEnv);

if (shouldReuse && existsSync(resolve(uiDist, "index.html"))) {
  console.log("  -> Reusing existing @paperclipai/ui dist output");
} else {
  console.log("  -> Building @paperclipai/ui...");
  const pnpm = resolvePnpmInvocation();
  const result = spawnSync(pnpm.command, [...pnpm.argsPrefix, "--filter", "@paperclipai/ui", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    // A bare `pnpm` on Windows is pnpm.cmd, which needs the shell to resolve.
    // pnpm's JavaScript entry point is run directly so paths with spaces remain
    // separate arguments and are not interpolated into a shell command.
    shell: pnpm.command === "pnpm" && process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(resolve(uiDist, "index.html"))) {
  console.error(`UI build output missing at ${uiDist}/index.html`);
  process.exit(1);
}

rmSync(serverUiDist, { recursive: true, force: true });
cpSync(uiDist, serverUiDist, { recursive: true });
console.log("  -> Copied ui/dist to server/ui-dist");
