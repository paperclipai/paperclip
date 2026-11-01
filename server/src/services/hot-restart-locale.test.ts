import { afterEach, describe, expect, it, vi } from "vitest";
import { readProcessStartedAt } from "./hot-restart.js";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  execFile.mockReset();
});

describe("process start time locale", () => {
  it("leaves PowerShell's environment unchanged", async () => {
    vi.stubEnv("LC_ALL", "zh_CN.UTF-8");
    execFile.mockImplementation((
      command: string,
      _args: string[],
      options: { env?: NodeJS.ProcessEnv },
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      expect(command).toBe("powershell.exe");
      expect(options.env).toBeUndefined();
      callback(null, "2026-10-23T22:22:44.000Z\r\n");
    });

    await expect(readProcessStartedAt(456, { platform: "win32" })).resolves.toBe(
      "2026-10-23T22:22:44.000Z",
    );
    expect(process.env.LC_ALL).toBe("zh_CN.UTF-8");
  });

  it.each(["darwin", "freebsd", "openbsd", "aix", "sunos"] as const)(
    "reads %s timestamps without changing the server locale",
    async (platform) => {
      vi.stubEnv("LANG", "zh_CN.UTF-8");
      vi.stubEnv("LC_ALL", "zh_CN.UTF-8");
      vi.stubEnv("LC_TIME", "zh_CN.UTF-8");
      execFile.mockImplementation((
        command: string,
        args: string[],
        options: { env?: NodeJS.ProcessEnv },
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        expect(command).toBe("ps");
        expect(args).toEqual(["-o", "lstart=", "-p", "456"]);
        expect(options.env?.PATH).toBe(process.env.PATH);
        callback(null, options.env?.LC_ALL === "C"
          ? "Fri Oct 23 22:22:44 2026\n"
          : "五 10月/23 22:22:44 2026\n");
      });

      await expect(readProcessStartedAt(456, { platform })).resolves.toBe(
        new Date("Fri Oct 23 22:22:44 2026").toISOString(),
      );
      expect(process.env.LANG).toBe("zh_CN.UTF-8");
      expect(process.env.LC_ALL).toBe("zh_CN.UTF-8");
      expect(process.env.LC_TIME).toBe("zh_CN.UTF-8");
    },
  );
});
