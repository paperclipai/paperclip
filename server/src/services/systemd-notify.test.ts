import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import { systemdNotify } from "./systemd-notify.js";

const originalNotifySocket = process.env.NOTIFY_SOCKET;

describe("systemdNotify", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    process.env.NOTIFY_SOCKET = "/run/systemd/notify";
  });

  afterEach(() => {
    if (originalNotifySocket === undefined) {
      delete process.env.NOTIFY_SOCKET;
    } else {
      process.env.NOTIFY_SOCKET = originalNotifySocket;
    }
  });

  it("bounds the notification subprocess and resolves false on timeout", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        options: Record<string, unknown>,
        callback: (error: Error | null) => void,
      ) => {
        expect(options).toMatchObject({
          windowsHide: true,
          timeout: 2_000,
          killSignal: "SIGTERM",
        });
        callback(new Error("systemd-notify timed out"));
        return {};
      },
    );

    await expect(systemdNotify(["--stopping"])).resolves.toBe(false);
  });
});
