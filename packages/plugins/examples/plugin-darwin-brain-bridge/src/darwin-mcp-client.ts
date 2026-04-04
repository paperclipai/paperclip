import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { DarwinClientOptions, DarwinToolResult } from "./types.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function encodeMessage(message: JsonRpcRequest): string {
  return `${JSON.stringify(message)}\n`;
}

class MessageBuffer {
  private buffer = "";

  push(chunk: Buffer): JsonRpcResponse[] {
    this.buffer += chunk.toString("utf8");
    const messages: JsonRpcResponse[] = [];

    while (true) {
      const lineEnd = this.buffer.indexOf("\n");
      if (lineEnd === -1) break;

      const line = this.buffer.slice(0, lineEnd).replace(/\r$/, "");
      this.buffer = this.buffer.slice(lineEnd + 1);
      if (line.trim() === "") continue;
      messages.push(JSON.parse(line) as JsonRpcResponse);
    }

    return messages;
  }
}

async function waitForResponse(
  child: ChildProcessWithoutNullStreams,
  stdoutBuffer: MessageBuffer,
  id: number,
  timeoutMs: number,
): Promise<JsonRpcResponse> {
  return await new Promise<JsonRpcResponse>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      try {
        const messages = stdoutBuffer.push(chunk);
        for (const message of messages) {
          if (message.id === id) {
            cleanup();
            resolve(message);
            return;
          }
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Darwin MCP exited before response (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Darwin MCP timed out waiting for response ${id}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };

    child.stdout.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

export async function callDarwinTool(
  options: DarwinClientOptions,
  toolName: string,
  args: Record<string, unknown>,
): Promise<DarwinToolResult> {
  const child = spawn(options.command, options.args, {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const stdoutBuffer = new MessageBuffer();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  try {
    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "paperclip-darwin-brain-bridge",
            version: "0.1.0",
          },
        },
      }),
    );

    const initializeResponse = await waitForResponse(child, stdoutBuffer, 1, options.timeoutMs);
    if (initializeResponse.error) {
      throw new Error(`Darwin MCP initialize failed: ${initializeResponse.error.message}`);
    }

    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    );

    child.stdin.write(
      encodeMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
      }),
    );

    const toolResponse = await waitForResponse(child, stdoutBuffer, 2, options.timeoutMs);
    if (toolResponse.error) {
      throw new Error(`Darwin MCP tool error: ${toolResponse.error.message}`);
    }

    return (toolResponse.result ?? {}) as DarwinToolResult;
  } catch (error) {
    const suffix = stderr.trim() ? ` stderr=${stderr.trim()}` : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
  } finally {
    child.kill();
  }
}
