import { execFile } from "node:child_process";

const SYSTEMD_SERVICE_MANAGER_ENV_KEYS = [
  "NOTIFY_SOCKET",
  "LISTEN_FDS",
  "LISTEN_PID",
  "LISTEN_FDNAMES",
] as const;

export function consumeSystemdNotifySocket(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const notifySocket = env.NOTIFY_SOCKET?.trim() ?? "";
  for (const key of SYSTEMD_SERVICE_MANAGER_ENV_KEYS) {
    delete env[key];
  }
  return notifySocket;
}

const startupNotifySocket = consumeSystemdNotifySocket();

export async function systemdNotify(args: string[]): Promise<boolean> {
  const notifySocket =
    consumeSystemdNotifySocket() || startupNotifySocket;
  if (!notifySocket) return false;
  return await new Promise<boolean>((resolve) => {
    execFile(
      "systemd-notify",
      args,
      {
        windowsHide: true,
        env: { ...process.env, NOTIFY_SOCKET: notifySocket },
      },
      (error) => resolve(!error),
    );
  });
}
