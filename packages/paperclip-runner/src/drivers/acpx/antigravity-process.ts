import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export async function checkAntigravityPrivateHome(home: string): Promise<void> {
  if (!isAbsolute(home) || home.includes("\0") || resolve(home) !== home || await realpath(home) !== home) throw new Error("Invalid Antigravity private home");
  const stat = await lstat(home);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error("Invalid Antigravity private home");
}

/** Owned setup environment; never inherits credentials, endpoints, hooks,
 * Python startup options, proxy routing, or user configuration from the host. */
export async function antigravityPrivateEnvironment(home: string): Promise<NodeJS.ProcessEnv> {
  await checkAntigravityPrivateHome(home);
  for (const name of ["host-home", "config", "data", "cache", "tmp"]) {
    const directory = join(home, name);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error("Invalid Antigravity private home");
  }
  return {
    PATH: "/usr/bin:/bin", HOME: join(home, "host-home"), GEMINI_HOME: home,
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), TMPDIR: join(home, "tmp"),
    // Success prevents Python webbrowser from trying its next OS controller.
    BROWSER: "/usr/bin/true", AGY_ACP_FORCE_FILE_STORAGE: "1", NO_COLOR: "1", LANG: "en_US.UTF-8",
  };
}

export async function retireAntigravityProcess(child: ChildProcessWithoutNullStreams, closed: Promise<void>): Promise<void> {
  let retired = false;
  void closed.then(() => { retired = true; });
  const signal = (value: NodeJS.Signals) => {
    try { if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, value); else if (!retired) child.kill(value); }
    catch (error) { if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  };
  const alive = async () => {
    let groupAlive = !retired;
    if (process.platform !== "win32" && child.pid !== undefined) {
      try { process.kill(-child.pid, 0); groupAlive = true; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") groupAlive = false;
        else if (code === "EPERM" && process.platform === "darwin") {
          // Darwin reports EPERM for some groups containing only orphaned
          // zombies. Read numeric state only; never process arguments/env.
          const output = await new Promise<string>((resolve, reject) => execFile("/bin/ps", ["-axo", "pid=,pgid=,stat="], {
            encoding: "utf8", timeout: 1_000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C" },
          }, (error, stdout) => error ? reject(error) : resolve(stdout)));
          const rows = output.trim().split("\n").filter(Boolean).map(line => line.trim().split(/\s+/));
          if (rows.some(row => row.length !== 3 || !/^\d+$/.test(row[0]!) || !/^\d+$/.test(row[1]!) || !/^[A-Za-z+<>NLsWX-]+$/.test(row[2]!))) throw new Error("Antigravity process retirement could not be confirmed");
          groupAlive = rows.some(row => Number(row[1]) === child.pid && !row[2]!.startsWith("Z"));
        } else throw error;
      }
    }
    return groupAlive;
  };
  child.stdin.end();
  for (const [value, wait] of [[null, 500], ["SIGTERM", 500], ["SIGKILL", 1_000]] as const) {
    if (value) signal(value);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + wait;
    await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(resolve, wait); })]);
    if (timer) clearTimeout(timer);
    if (!await alive()) return;
    // A descendant can keep running after the launcher exits. Observe the
    // remainder of this stage's deadline before escalating the owned group.
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    if (!await alive()) return;
  }
  throw new Error("Antigravity process retirement could not be confirmed");
}
