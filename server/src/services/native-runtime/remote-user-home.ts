import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

export async function readRemoteUserHome(runner: Pick<CommandManagedRuntimeRunner, "execute">): Promise<string> {
  const result = await runner.execute({ command: "sh", args: ["-c", 'printf "%s\\n" "$HOME"', "paperclip-remote-home"],
    bypassSession: true, timeoutMs: 10_000 });
  const home = result.stdout.trim();
  if (result.exitCode !== 0 || result.timedOut || !home.startsWith("/") || /[\0\r\n]/.test(home)) {
    throw new Error("runner_preconfigured_remote_home_unavailable");
  }
  return home;
}
