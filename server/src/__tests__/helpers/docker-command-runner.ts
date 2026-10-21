import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { createServer } from "node:tls";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

export function dockerCommandRunner(container: string): CommandManagedRuntimeRunner {
  return {
    async execute(input) {
      const args = ["exec", "-i", "-u", "root"];
      if (input.cwd) args.push("-w", input.cwd);
      for (const [name, value] of Object.entries(input.env ?? {})) args.push("-e", `${name}=${value}`);
      args.push(container, input.command, ...(input.args ?? []));
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      const startedAt = new Date().toISOString();
      let stdout = "", stderr = "", timedOut = false;
      child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, input.timeoutMs ?? 30_000);
      child.stdin.on("error", () => undefined);
      child.stdin.end(input.stdin);
      try {
        return await new Promise<Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>>>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", (exitCode, signal) => resolve({ exitCode, signal, timedOut, stdout, stderr, pid: child.pid ?? null, startedAt }));
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function createRunnerTestTlsTunnel(input: { key: string; cert: string; port: number }) {
  const sockets = new Set<Socket>();
  const server = createServer({ key: await readFile(input.key), cert: await readFile(input.cert) }, socket => {
    const upstream = createConnection({ host: "127.0.0.1", port: input.port });
    for (const connection of [socket, upstream]) {
      sockets.add(connection);
      connection.on("close", () => sockets.delete(connection));
      connection.on("error", () => { socket.destroy(); upstream.destroy(); });
    }
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test TLS listener unavailable");
  return { port: address.port, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
