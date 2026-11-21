import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

describe("Windows terminal supervisor cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    execFileMock.mockReset();
  });

  it("rebuilds the cached supervisor after its temporary directory is removed", async () => {
    const compiledExecutables = new Set<string>();
    const realStat = fs.stat.bind(fs);
    vi.spyOn(fs, "stat").mockImplementation((async (target: string | URL) => {
      const value = String(target);
      if (value.endsWith("csc.exe")) return { isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>;
      if (value.endsWith("ProcessJob.exe")) {
        if (compiledExecutables.has(value)) return { isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>;
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      }
      return await realStat(target as never);
    }) as typeof fs.stat);
    execFileMock.mockImplementation((_compiler: string, args: string[], _options: unknown, callback: (error: Error | null, result?: unknown) => void) => {
      const out = args.find((arg) => arg.startsWith("/out:"));
      if (out) compiledExecutables.add(out.slice("/out:".length));
      callback(null, { stdout: "", stderr: "" });
    });

    const { prepareWindowsTerminalJob } = await import("./windows-terminal-job.js");
    const first = await prepareWindowsTerminalJob("provider.exe", ["--resume"]);
    const firstSupervisorDirectory = path.dirname(first.command);
    await fs.rm(firstSupervisorDirectory, { recursive: true, force: true });
    compiledExecutables.delete(first.command);

    const second = await prepareWindowsTerminalJob("provider.exe", ["--resume"]);
    try {
      expect(second.command).not.toBe(first.command);
      expect(execFileMock).toHaveBeenCalledTimes(2);
      await expect(fs.stat(second.command)).resolves.toBeDefined();
    } finally {
      await Promise.all([first.settle(), second.settle()]);
      await fs.rm(path.dirname(second.command), { recursive: true, force: true });
    }
  });
});
