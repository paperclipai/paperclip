import type { ChildProcess } from "node:child_process";

export async function waitForServer(
  apiBase: string,
  child: Pick<ChildProcess, "exitCode">,
  output: { stdout: string[]; stderr: string[] },
  deadline: number,
) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `paperclipai run exited before healthcheck succeeded.\nstdout:\n${output.stdout.join("")}\nstderr:\n${output.stderr.join("")}`,
      );
    }

    try {
      const res = await fetch(`${apiBase}/api/health`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, deadline - Date.now()))),
      });
      if (res.ok) return;
    } catch {
      // Server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(250, deadline - Date.now()))));
  }

  throw new Error(
    `Timed out waiting for ${apiBase}/api/health.\nstdout:\n${output.stdout.join("")}\nstderr:\n${output.stderr.join("")}`,
  );
}
