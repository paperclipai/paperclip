import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DaytonaPtyCreateOptions } from "./login-pty.js";

vi.mock("./plugin.js", async () => {
  const { NOOP_PLUGIN_TRACER } = await import("@paperclipai/plugin-sdk");
  return { getPluginTracer: () => NOOP_PLUGIN_TRACER };
});
import { performSyncOut } from "./file-sync.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const executable = (names: string[], version: string) => names.map(name => {
  const resolved = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", name], { encoding: "utf8" }).stdout?.trim();
  return resolved && spawnSync(resolved, ["--version"], { encoding: "utf8" }).stdout?.includes(version) ? resolved : undefined;
}).find(Boolean);
// Match the provider's GNU tools. Hosts without these or Python's PTY relay
// skip this integration regression, like the nearby real-GNU-tar tests.
const requiredTools = {
  tar: executable(["gtar", "tar"], "GNU tar"),
  dd: executable(["gdd", "dd"], "coreutils"),
  base64: executable(["gbase64", "base64"], "coreutils"),
  bash: executable(["bash"], "GNU bash"),
  python3: executable(["python3"], "Python 3."),
};
const ptyRelay = `
import os, pty, select, signal, sys
pid, fd = pty.fork()
if pid == 0:
    os.execlp("bash", "bash", "--noprofile", "--norc")
def stop(*args):
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    sys.exit(1)
signal.signal(signal.SIGTERM, stop)
while True:
    ready, _, _ = select.select([0, fd], [], [])
    for src in ready:
        try: data = os.read(src, 65536)
        except OSError: data = b""
        if not data:
            _, status = os.waitpid(pid, 0)
            sys.exit(os.waitstatus_to_exitcode(status))
        dst = fd if src == 0 else 1
        while data:
            data = data[os.write(dst, data):]
`;

it.skipIf(Object.values(requiredTools).some(tool => !tool)).each(["success", "producer failure", "sparse archive over budget"])("preserves source bytes under archive capacity failure: %s", async scenario => {
  const producerFails = scenario === "producer failure";
  const sparseOverBudget = scenario === "sparse archive over budget";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "daytona-capacity-"));
  roots.push(root);
  const remote = path.join(root, "remote");
  const output = path.join(root, "output");
  const bin = path.join(root, "bin");
  await fs.mkdir(remote);
  await fs.mkdir(bin);
  for (const name of ["dd", "base64", "bash"] as const) {
    await fs.symlink(requiredTools[name]!, path.join(bin, name));
  }
  const tar = requiredTools.tar!;
  if (producerFails) {
    await fs.writeFile(path.join(bin, "tar"), `#!/bin/sh\n'${tar}' "$@"\nstatus=$?\ncase " $* " in *" -f - "*) exit 23 ;; esac\nexit "$status"\n`, { mode: 0o755 });
  } else {
    await fs.symlink(tar, path.join(bin, "tar"));
  }
  if (producerFails || sparseOverBudget) {
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, "result.bin"), "newer host work");
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const bytes = Buffer.alloc(5 * 1024 * 1024, sparseOverBudget ? 0 : "saved work\n");
  await fs.writeFile(path.join(remote, "result.bin"), sparseOverBudget ? "" : bytes, { mode: 0o600 });
  if (sparseOverBudget) await fs.truncate(path.join(remote, "result.bin"), bytes.length);
  await fs.symlink("/etc/passwd", path.join(remote, "unsafe-link"));
  await fs.symlink("result.bin", path.join(remote, "safe-link"));
  const failures: string[] = [];
  const sandbox = {
    // A miniature provider-reported quota makes the sparse-file case bounded.
    disk: sparseOverBudget ? 1 / 4096 : 1,
    process: {
      executeCommand: async (command: string) => {
        const result = spawnSync("bash", ["-c", 'ulimit -f 128; exec sh -c "$1"', "bash", command], { env, encoding: "utf8" });
        if (result.status !== 0) failures.push(result.stderr);
        return { exitCode: result.status ?? 1, result: result.stdout + result.stderr };
      },
      createPty: async (options: DaytonaPtyCreateOptions) => {
        // A real PTY exercises raw-mode startup, echo suppression and the
        // canonical line limit, including the longer safe-link retry script.
        const child = spawn(requiredTools.python3!, ["-c", ptyRelay], { env, cwd: options.cwd });
        child.stdout.on("data", options.onData);
        const completion = new Promise<{ exitCode: number }>(resolve => child.once("exit", code => resolve({ exitCode: code ?? 1 })));
        return {
          waitForConnection: async () => {},
          sendInput: async (data: string | Uint8Array) => { child.stdin.write(Buffer.from(data)); },
          wait: () => completion,
          kill: async () => { child.kill(); },
          disconnect: async () => { child.kill(); },
        };
      },
    },
    fs: {
      downloadFiles: async (requests: Array<{ source: string; destination: string }>) => {
        for (const request of requests) await fs.copyFile(request.source, request.destination);
        return requests.map(({ source }) => ({ source }));
      },
      deleteFile: (file: string) => fs.rm(file, { force: true }),
    },
  };
  const sync = performSyncOut({ sandbox: sandbox as never, remoteDir: remote, timeoutSeconds: 30,
    operations: [{ operationId: "export", files: [{ sourcePath: remote, targetPath: output, kind: "directory" }] }],
  });
  if (producerFails || sparseOverBudget) {
    await expect(sync).rejects.toThrow(sparseOverBudget ? "sandbox disk budget" : "without a successful archive receipt");
    expect(await fs.readFile(path.join(output, "result.bin"), "utf8")).toBe("newer host work");
    expect(await fs.readdir(output)).toEqual(["result.bin"]);
    expect((await fs.readFile(path.join(remote, "result.bin"))).equals(bytes)).toBe(true);
    return;
  }
  await sync;
  expect(failures.join("\n")).toMatch(/File\s?size limit exceeded/i);
  expect((await fs.readFile(path.join(output, "result.bin"))).equals(bytes)).toBe(true);
  expect((await fs.readFile(path.join(remote, "result.bin"))).equals(bytes)).toBe(true);
  expect((await fs.stat(path.join(output, "result.bin"))).mode & 0o777).toBe(0o600);
  expect(await fs.readlink(path.join(output, "safe-link"))).toBe("result.bin");
  expect(await fs.readdir(output)).not.toContain("unsafe-link");
  expect(await fs.readlink(path.join(remote, "unsafe-link"))).toBe("/etc/passwd");
  expect((await fs.readdir(remote)).filter(name => name.startsWith(".paperclip-upload"))).toEqual([]);
}, 40_000);
