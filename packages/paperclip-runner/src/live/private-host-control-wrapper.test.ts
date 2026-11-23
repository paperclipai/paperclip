import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const wrapper = fileURLToPath(new URL("../../test/support/private-host-control.py", import.meta.url));

// The wrapper's forward thread stays blocked reading stdin after the native
// child exits. Normal interpreter shutdown then aborted with SIGABRT, which on
// macOS opened a "Python quit unexpectedly" dialog for every test run.
it.skipIf(process.platform === "win32")("exits cleanly while its stdin is still open", async () => {
  const child = spawn("python3", [wrapper, "/bin/sh", "-c", "sleep 0.3"], {
    detached: true, stdio: ["pipe", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.destroy();

  expect(exit).toEqual({ code: 0, signal: null });
  expect(stdout).toContain('"fixture": "exited"');
}, 15_000);
