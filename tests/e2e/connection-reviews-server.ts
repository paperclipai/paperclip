import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const controlPath = process.env.PAPERCLIP_REVIEW_RESTART_FILE;
if (!controlPath) throw new Error("PAPERCLIP_REVIEW_RESTART_FILE is required");
let child: ChildProcess;
let stopping = false;
let restarting = false;
function launch(first: boolean) {
  const launched = spawn(
    process.execPath,
    [
      "--import",
      "./cli/node_modules/tsx/dist/loader.mjs",
      "cli/src/index.ts",
      ...(first ? ["onboard", "--yes", "--run"] : ["run"]),
    ],
    { stdio: "inherit", detached: true, env: process.env },
  );
  child = launched;
  launched.once("exit", (code) => {
    // An old child's exit notification may arrive after its replacement starts.
    if (child === launched && !stopping && !restarting) process.exit(code ?? 1);
  });
}
async function stopChild() {
  const pid = child.pid;
  if (!pid) return;
  // tsx may exit before its server child. Track the owned process group, not
  // only the launcher, so restarts and Playwright teardown cannot leak servers.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    stopping = true;
    clearInterval(timer);
    void stopChild().finally(() => process.exit(0));
  });
// Also clean up after an unexpected supervisor exit; the server is detached
// only so the restart test can stop its entire owned process group.
process.on("exit", () => {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
});
launch(true);
const timer = setInterval(async () => {
  if (stopping || restarting) return;
  const command = await readFile(controlPath, "utf8").catch(() => "");
  if (!command.startsWith("restart:")) return;
  restarting = true;
  try {
    await stopChild();
    launch(false);
    await writeFile(controlPath, command.replace("restart:", "started:"));
  } finally {
    restarting = false;
  }
}, 250);
