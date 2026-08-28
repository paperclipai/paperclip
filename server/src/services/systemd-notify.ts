import { execFile } from "node:child_process";

export async function systemdNotify(args: string[]): Promise<boolean> {
  if (!process.env.NOTIFY_SOCKET?.trim()) return false;
  return await new Promise<boolean>((resolve) => {
    execFile("systemd-notify", args, { windowsHide: true }, (error) => resolve(!error));
  });
}
