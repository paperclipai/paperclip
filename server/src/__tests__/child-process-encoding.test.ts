import { describe, expect, it } from "vitest";
import { buildChildProcessEnv } from "@paperclipai/adapter-utils/server-utils";

describe("child process encoding environment", () => {
  it("forces Python UTF-8 mode on Windows child processes", () => {
    const env = buildChildProcessEnv({ PATH: "C:\\Windows\\System32" }, "win32");

    expect(env.PYTHONUTF8).toBe("1");
    expect(env.PYTHONIOENCODING).toBe("utf-8");
  });

  it("preserves explicit Python encoding overrides on Windows", () => {
    const env = buildChildProcessEnv(
      {
        PATH: "C:\\Windows\\System32",
        PYTHONUTF8: "0",
        PYTHONIOENCODING: "cp1251",
      },
      "win32",
    );

    expect(env.PYTHONUTF8).toBe("0");
    expect(env.PYTHONIOENCODING).toBe("cp1251");
  });

  it("does not inject Python-specific encoding hints outside Windows", () => {
    const env = buildChildProcessEnv({ PATH: "/usr/bin:/bin" }, "linux");

    expect(env.PYTHONUTF8).toBeUndefined();
    expect(env.PYTHONIOENCODING).toBeUndefined();
  });
});