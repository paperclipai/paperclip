import { execFile } from "node:child_process";

const systemdNotifyTimeoutMs = 2_000;

export async function systemdNotify(args: string[]): Promise<boolean> {
  if (!process.env.NOTIFY_SOCKET?.trim()) return false;
  return await new Promise<boolean>((resolve) => {
    execFile(
      "systemd-notify",
      args,
      {
        windowsHide: true,
        timeout: systemdNotifyTimeoutMs,
        killSignal: "SIGTERM",
      },
      (error) => resolve(!error),
    );
  });
}
