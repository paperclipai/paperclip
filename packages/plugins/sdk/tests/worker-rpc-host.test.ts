import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { definePlugin } from "../src/define-plugin.js";
import { isWorkerEntrypoint, startWorkerRpcHost } from "../src/worker-rpc-host.js";

describe("isWorkerEntrypoint", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  function createTempRoot(): string {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sdk-worker-"));
    tempRoots.push(tempRoot);
    return tempRoot;
  }

  it("matches an entrypoint reached through a symlinked directory", () => {
    const tempRoot = createTempRoot();
    const realDir = path.join(tempRoot, "real");
    const linkDir = path.join(tempRoot, "link");
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkDir, "dir");

    const workerPath = path.join(realDir, "worker.js");
    fs.writeFileSync(workerPath, "");

    expect(
      isWorkerEntrypoint(
        path.join(linkDir, "worker.js"),
        pathToFileURL(workerPath).toString(),
      ),
    ).toBe(true);
  });

  it("does not match a different entrypoint", () => {
    const tempRoot = createTempRoot();
    const workerPath = path.join(tempRoot, "worker.js");
    const otherPath = path.join(tempRoot, "other.js");
    fs.writeFileSync(workerPath, "");
    fs.writeFileSync(otherPath, "");

    expect(
      isWorkerEntrypoint(
        otherPath,
        pathToFileURL(workerPath).toString(),
      ),
    ).toBe(false);
  });
});

describe("startWorkerRpcHost runtime company context", () => {
  function collectJsonLines(stream: PassThrough) {
    const queue: unknown[] = [];
    const waiters: Array<(value: unknown) => void> = [];
    let buffer = "";

    stream.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          const message = JSON.parse(line);
          const waiter = waiters.shift();
          if (waiter) waiter(message);
          else queue.push(message);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });

    return async function nextMessage(): Promise<any> {
      const queued = queue.shift();
      if (queued) return queued;
      return new Promise((resolve) => waiters.push(resolve));
    };
  }

  function writeMessage(stream: PassThrough, message: unknown): void {
    stream.write(`${JSON.stringify(message)}\n`);
  }

  it("passes executeTool company context into config and secret host calls", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const nextMessage = collectJsonLines(stdout);

    const plugin = definePlugin({
      async setup(ctx) {
        ctx.tools.register(
          "check-context",
          {
            displayName: "Check Context",
            description: "Checks runtime context propagation",
            parametersSchema: { type: "object", properties: {} },
          },
          async () => {
            const config = await ctx.config.get();
            const token = await ctx.secrets.resolve("77777777-7777-4777-8777-777777777777");
            return { content: `${config.mode}:${token}` };
          },
        );
      },
    });

    const host = startWorkerRpcHost({ plugin, stdin, stdout });

    writeMessage(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        manifest: { id: "test-plugin", name: "test-plugin", version: "1.0.0" },
        config: {},
        instanceInfo: { instanceId: "inst-1", hostVersion: "0.0.0-test" },
        apiVersion: 1,
      },
    });
    await expect(nextMessage()).resolves.toMatchObject({ id: 1, result: { ok: true } });

    writeMessage(stdin, {
      jsonrpc: "2.0",
      id: 2,
      method: "executeTool",
      params: {
        toolName: "check-context",
        parameters: {},
        runContext: {
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-1",
          projectId: "project-1",
        },
      },
    });

    const configRequest = await nextMessage();
    expect(configRequest).toMatchObject({
      method: "config.get",
      params: { companyId: "company-1" },
    });
    writeMessage(stdin, {
      jsonrpc: "2.0",
      id: configRequest.id,
      result: { mode: "company-config" },
    });

    const secretRequest = await nextMessage();
    expect(secretRequest).toMatchObject({
      method: "secrets.resolve",
      params: {
        secretRef: "77777777-7777-4777-8777-777777777777",
        companyId: "company-1",
      },
    });
    writeMessage(stdin, {
      jsonrpc: "2.0",
      id: secretRequest.id,
      result: "company-secret",
    });

    await expect(nextMessage()).resolves.toMatchObject({
      id: 2,
      result: { content: "company-config:company-secret" },
    });

    host.stop();
  });
});
