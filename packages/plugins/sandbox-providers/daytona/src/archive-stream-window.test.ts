import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DuplexChannelSession } from "./duplex-command-stream.js";

const { openSession } = vi.hoisted(() => ({ openSession: vi.fn() }));
vi.mock("./duplex-command-stream.js", () => ({ openDaytonaDuplexChannelSession: openSession }));
import { streamSandboxArchive } from "./archive-stream.js";

const roots: string[] = [];
const timers = new Set<ReturnType<typeof setTimeout>>();
const children = new Set<ReturnType<typeof spawn>>();
const executable = (names: string[], version: string) => names.map(name => {
  const resolved = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", name], { encoding: "utf8" }).stdout?.trim();
  return resolved && spawnSync(resolved, ["--version"], { encoding: "utf8" }).stdout?.includes(version) ? resolved : undefined;
}).find(Boolean);
const tools = { dd: executable(["gdd", "dd"], "coreutils"), base64: executable(["gbase64", "base64"], "coreutils") };

function kill(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

afterEach(async () => {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  for (const child of children) kill(child);
  children.clear();
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it.skipIf(process.platform === "win32" || !tools.dd || !tools.base64).each([0, 1024 * 1024 + 17])(
  "transfers %i bytes within its deadline across delayed acknowledgements", async size => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-credit-window-"));
    roots.push(root);
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await fs.symlink(tools.dd!, path.join(bin, "dd"));
    await fs.symlink(tools.base64!, path.join(bin, "base64"));
    const source = path.join(root, "source.bin");
    const destination = path.join(root, "saved.bin");
    const bytes = randomBytes(size);
    await fs.writeFile(source, bytes);
    let closed = false;
    openSession.mockImplementation(async (_process, command: string[]) => {
      const marker = command.join(" ").match(/paperclip-archive-[a-f0-9-]+/)![0];
      const child = spawn(command[0], command.slice(1), { cwd: root, detached: true,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ["pipe", "pipe", "pipe"] });
      children.add(child);
      let stderr = "";
      child.stderr!.on("data", chunk => { stderr += chunk.toString(); });
      const completion = new Promise<{ exitCode: number | null; transportClosed: boolean }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", code => {
          if (code && !closed) reject(new Error(stderr || `archive producer exited ${code}`));
          else resolve({ exitCode: code, transportClosed: false });
        });
      });
      return {
        onData: callback => { child.stdout!.on("data", callback); },
        write: data => {
          if (!data.toString().startsWith(marker)) { child.stdin!.write(data); return; }
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!closed) child.stdin!.write(data);
          }, 400);
          timers.add(timer);
        },
        wait: () => completion,
        kill: () => kill(child),
        close: async () => { closed = true; kill(child); await completion; },
      } satisfies DuplexChannelSession;
    });
    const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
    await streamSandboxArchive({ process: {} as never, cwd: root, archiveScript: `cat ${quote(source)}`,
      destination, timeoutSeconds: 4, maxBytes: size + 1024 });
    expect(await fs.readFile(destination)).toEqual(bytes);
    expect(await fs.readFile(source)).toEqual(bytes);
    expect(closed).toBe(true);
  }, 15_000,
);
