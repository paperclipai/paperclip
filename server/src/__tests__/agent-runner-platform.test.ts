import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: probe.execFileSync }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const architecture = Object.getOwnPropertyDescriptor(process, "arch")!;

beforeEach(() => {
  vi.resetModules();
  probe.execFileSync.mockReset();
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  Object.defineProperty(process, "arch", { ...architecture, value: "x64" });
  vi.spyOn(process.report, "getReport").mockImplementation(() => {
    throw new Error("Diagnostic reports must not be used for platform detection");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "arch", architecture);
});

function reply(stdout: string, error: Error | null = null) {
  probe.execFileSync.mockImplementation(() => {
    if (error) throw error;
    return stdout;
  });
}

describe("local runner platform probe", () => {
  it.each([
    ["glibc 2.38\n", "2.38", false],
    ["glibc 2.39\n", "2.39", true],
    [" glibc 2.41\n", "2.41", true],
    ["glibc 2.39.1", "2.39.1", true],
  ] as const)("uses getconf's measured version %s", async (stdout, version, supported) => {
    reply(stdout);
    const module = await import("../lib/agent-runner-platform.js");
    expect(module.localAgentRunnerTarget()).toEqual({
      driver: "local", platform: "linux", architecture: "x64",
      libc: "glibc", glibcVersion: version,
    });
    expect(module.localPaperclipRunnerSupported()).toBe(supported);
    expect(process.report.getReport).not.toHaveBeenCalled();
  });

  it("probes once before discovery, with a bounded command", async () => {
    reply("glibc 2.41\n");
    const module = await import("../lib/agent-runner-platform.js");
    const first = module.localAgentRunnerTarget();
    first.glibcVersion = "0.0";
    for (let index = 0; index < 10; index++) {
      expect(module.localAgentRunnerTarget().glibcVersion).toBe("2.41");
    }
    expect(probe.execFileSync).toHaveBeenCalledTimes(1);
    expect(probe.execFileSync).toHaveBeenCalledWith("getconf", ["GNU_LIBC_VERSION"], {
      encoding: "utf8", timeout: 1_000, killSignal: "SIGKILL", maxBuffer: 1_024, stdio: ["ignore", "pipe", "ignore"],
    });
  });

  it("keeps the measured version when module loading blocks the event loop past the timeout", async () => {
    const { execFileSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    probe.execFileSync.mockImplementation((_command, _args, options) => {
      const stdout = execFileSync(process.execPath, ["-e", "console.log('glibc 2.41')"], options);
      const blockedUntil = Date.now() + 1_200;
      while (Date.now() < blockedUntil);
      return stdout;
    });
    const module = await import("../lib/agent-runner-platform.js");
    expect(module.localAgentRunnerTarget()).toMatchObject({ libc: "glibc", glibcVersion: "2.41" });
    expect(module.localPaperclipRunnerSupported()).toBe(true);
  });

  it.each(["", "musl 1.2.5", "glibc malformed", "glibc 2.39ubuntu1", "glibc 2.41\nprivate-data"])(
    "fails closed for unrecognized output %s", async stdout => {
      reply(stdout);
      const module = await import("../lib/agent-runner-platform.js");
      expect(module.localAgentRunnerTarget()).toMatchObject({ libc: "unknown" });
      expect(module.localAgentRunnerTarget()).not.toHaveProperty("glibcVersion");
      expect(module.localPaperclipRunnerSupported()).toBe(false);
    },
  );

  it.each(["ENOENT", "ETIMEDOUT", "ENOBUFS"])(
    "keeps discovery available and fails closed on %s", async code => {
      reply("", Object.assign(new Error("probe failed"), { code }));
      const module = await import("../lib/agent-runner-platform.js");
      expect(module.localAgentRunnerTarget()).toMatchObject({ libc: "unknown" });
      expect(module.localPaperclipRunnerSupported()).toBe(false);
      expect(probe.execFileSync).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["darwin", "win32"])("does not probe libc on %s", async value => {
    Object.defineProperty(process, "platform", { ...platform, value });
    const module = await import("../lib/agent-runner-platform.js");
    expect(module.localAgentRunnerTarget()).toEqual({ driver: "local", platform: value, architecture: "x64" });
    expect(probe.execFileSync).not.toHaveBeenCalled();
  });
});
