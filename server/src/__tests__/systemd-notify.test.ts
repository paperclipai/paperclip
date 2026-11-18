import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("systemdNotify", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    delete process.env.NOTIFY_SOCKET;
    delete process.env.LISTEN_FDS;
    delete process.env.LISTEN_PID;
    delete process.env.LISTEN_FDNAMES;
  });

  afterEach(() => {
    for (const key of [
      "NOTIFY_SOCKET",
      "LISTEN_FDS",
      "LISTEN_PID",
      "LISTEN_FDNAMES",
    ] as const) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it("extracts the trimmed notify socket and deletes systemd manager env vars", async () => {
    const { consumeSystemdNotifySocket } = await import("../services/systemd-notify.js");
    const env: NodeJS.ProcessEnv = {
      NOTIFY_SOCKET: "  /run/user/1000/systemd/notify  ",
      LISTEN_FDS: "2",
      LISTEN_PID: "4242",
      LISTEN_FDNAMES: "http:grpc",
      PATH: "/usr/bin",
    };

    expect(consumeSystemdNotifySocket(env)).toBe("/run/user/1000/systemd/notify");
    expect(env.NOTIFY_SOCKET).toBeUndefined();
    expect(env.LISTEN_FDS).toBeUndefined();
    expect(env.LISTEN_PID).toBeUndefined();
    expect(env.LISTEN_FDNAMES).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("scrubs process.env at import time and passes NOTIFY_SOCKET only to systemd-notify", async () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    process.env.LISTEN_FDS = "1";
    process.env.LISTEN_PID = "999";
    process.env.LISTEN_FDNAMES = "web";

    const { systemdNotify } = await import("../services/systemd-notify.js");

    expect(process.env.NOTIFY_SOCKET).toBeUndefined();
    expect(process.env.LISTEN_FDS).toBeUndefined();
    expect(process.env.LISTEN_PID).toBeUndefined();
    expect(process.env.LISTEN_FDNAMES).toBeUndefined();

    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null));

    await expect(
      systemdNotify(["--ready", "--status=Listening on 127.0.0.1:3100"]),
    ).resolves.toBe(true);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "systemd-notify",
      ["--ready", "--status=Listening on 127.0.0.1:3100"],
      expect.objectContaining({
        windowsHide: true,
        env: expect.objectContaining({
          NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
        }),
      }),
      expect.any(Function),
    );
    expect(process.env.NOTIFY_SOCKET).toBeUndefined();
  });

  it("returns false without spawning systemd-notify when NOTIFY_SOCKET is unset", async () => {
    const { systemdNotify } = await import("../services/systemd-notify.js");

    await expect(systemdNotify(["--ready"])).resolves.toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("returns false when systemd-notify exits with an error", async () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    const { systemdNotify } = await import("../services/systemd-notify.js");

    execFileMock.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(new Error("systemd-notify failed")),
    );

    await expect(systemdNotify(["--stopping"])).resolves.toBe(false);
  });
});
