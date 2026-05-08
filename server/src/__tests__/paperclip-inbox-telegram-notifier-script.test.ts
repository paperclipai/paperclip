import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type AddressInfo } from "node:net";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("notify:paperclip-inbox-telegram package script", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("runs successfully from the repo root when the inbox count is unchanged", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-inbox-telegram-"));
    const stateFile = path.join(tempDir, "state.json");
    await writeFile(
      stateFile,
      JSON.stringify(
        {
          lastObservedInboxCount: 1,
          lastObservedAt: "2026-05-02T10:20:00.000Z",
          lastNotifiedInboxCount: 1,
          lastNotifiedAt: "2026-05-02T10:20:00.000Z",
        },
        null,
        2,
      ),
      "utf8",
    );

    const server = await listenJsonServer({ inbox: 1, approvals: 0, failedRuns: 1, joinRequests: 0 });
    cleanup.push(() => server.close());

    const result = await runCommand("pnpm", ["run", "notify:paperclip-inbox-telegram"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PAPERCLIP_API_BASE: `${server.baseUrl}/api`,
        PAPERCLIP_COMPANY_ID: "test-company",
        PAPERCLIP_TELEGRAM_BOT_TOKEN: "unused-token",
        PAPERCLIP_TELEGRAM_CHAT_ID: "unused-chat",
        PAPERCLIP_INBOX_STATE_FILE: stateFile,
      },
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    expect(payload.shouldNotify).toBe(false);
    expect(payload.reason).toBe("no_action_needed");

    const state = JSON.parse(await readFile(stateFile, "utf8"));
    expect(state.lastObservedInboxCount).toBe(1);
    expect(state.lastNotifiedInboxCount).toBe(1);
  }, 30_000);
});

async function listenJsonServer(payload: unknown): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((socket) => {
    socket.once("data", () => {
      const body = JSON.stringify(payload);
      socket.end(
        [
          "HTTP/1.1 200 OK",
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(body)}`,
          "Connection: close",
          "",
          body,
        ].join("\r\n"),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`command failed with exit ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
  });
}
