#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Version info
const VERSION = "1.0.0";

// Ensure all console logs go to stderr to preserve stdout for JSON-RPC
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

process.on("unhandledRejection", (reason) => {
  console.error("[muse-acp] Unhandled rejection:", reason);
});

// UUIDv7 generator for Muse Server Protocol idempotency keys
export function uuidv7(): string {
  const now = Date.now();
  const timeHex = now.toString(16).padStart(12, "0");
  const randA = Math.floor(Math.random() * 0x0fff).toString(16).padStart(3, "0");
  const variant = (0x8000 | Math.floor(Math.random() * 0x3fff)).toString(16).padStart(4, "0");
  const randB = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${randA}-${variant}-${randB}`;
}

export interface CliOptions {
  provider: string;
  model: string;
  reasoningEffort?: string;
  command: string;
  disableSandbox: boolean;
  trustWorkspace: boolean;
  extraArgs: string[];
}

export function parseArgs(argv: string[]): { options: CliOptions; showVersion: boolean; showHelp: boolean } {
  let provider = process.env.MUSE_PROVIDER || "meta";
  let model = process.env.MUSE_MODEL || "muse-spark-1.3";
  let reasoningEffort = process.env.MUSE_REASONING_EFFORT;
  let command = process.env.MUSE_COMMAND || "muse";
  let disableSandbox = true;
  let trustWorkspace = true;
  let showVersion = false;
  let showHelp = false;
  const extraArgs: string[] = [];

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version" || arg === "-v") {
      showVersion = true;
    } else if (arg === "--help" || arg === "-h") {
      showHelp = true;
    } else if (arg === "--provider" && i + 1 < argv.length) {
      provider = argv[++i];
    } else if (arg === "--model" && i + 1 < argv.length) {
      model = argv[++i];
    } else if ((arg === "--reasoning-effort" || arg === "--effort") && i + 1 < argv.length) {
      reasoningEffort = argv[++i];
    } else if (arg === "--command" && i + 1 < argv.length) {
      command = argv[++i];
    } else if (arg === "--disable-sandbox") {
      disableSandbox = true;
    } else if (arg === "--trust-workspace") {
      trustWorkspace = true;
    } else {
      extraArgs.push(arg);
    }
  }

  return {
    options: {
      provider,
      model,
      reasoningEffort,
      command,
      disableSandbox,
      trustWorkspace,
      extraArgs,
    },
    showVersion,
    showHelp,
  };
}

export function resolveMuseExecutable(configuredCommand: string): string {
  if (configuredCommand && configuredCommand !== "muse") {
    return configuredCommand;
  }
  const fallback = path.join(os.homedir(), ".local/bin/muse");
  try {
    if (fs.existsSync(fallback)) return fallback;
  } catch {}
  return configuredCommand || "muse";
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: any;
}

export class MuseAcpBridge {
  private child: ChildProcess | null = null;
  private childRl: readline.Interface | null = null;
  private mspPendingRequests = new Map<
    number,
    { resolve: (val: any) => void; reject: (err: Error) => void }
  >();
  private nextMspId = 1;
  private currentTurnResolver: { resolve: (val: any) => void; reject: (err: Error) => void } | null = null;
  private activeSessionId: string | null = null;
  private itemKinds = new Map<string, string>(); // itemId -> kind
  private initializedPromise: Promise<void>;
  private resolveInitialized!: () => void;

  constructor(private options: CliOptions) {
    this.initializedPromise = new Promise((resolve) => {
      this.resolveInitialized = resolve;
    });
  }

  public async start(): Promise<void> {
    const museBin = resolveMuseExecutable(this.options.command);
    const args = [
      "serve",
      "--provider",
      this.options.provider,
      "--model",
      this.options.model,
    ];
    if (this.options.reasoningEffort) {
      args.push("--reasoning-effort", this.options.reasoningEffort);
    }
    if (this.options.disableSandbox) {
      args.push("--disable-sandbox");
    }
    if (this.options.trustWorkspace) {
      args.push("--trust-workspace");
    }
    args.push(...this.options.extraArgs);

    console.error(`[muse-acp] Spawning: ${museBin} ${args.join(" ")}`);
    this.child = spawn(museBin, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });

    this.child.on("error", (err) => {
      console.error("[muse-acp] Child process spawn error:", err);
      process.exit(1);
    });

    this.child.on("exit", (code, signal) => {
      console.error(`[muse-acp] Child process exited with code ${code}, signal ${signal}`);
      if (this.currentTurnResolver) {
        this.currentTurnResolver.reject(new Error(`Muse process exited (${code ?? signal})`));
        this.currentTurnResolver = null;
      }
      process.exit(code ?? 0);
    });

    if (!this.child.stdout || !this.child.stdin) {
      throw new Error("Failed to attach to child process stdio");
    }

    this.childRl = readline.createInterface({ input: this.child.stdout });
    this.childRl.on("line", (line) => this.handleMspLine(line));

    // Initial handshake with muse serve
    const initId = this.nextMspId++;
    this.sendMsp("initialize", { clientInfo: { name: "paperclip", version: "1.0.0" } }, initId);
    await this.initializedPromise;
  }

  private sendMsp(method: string, params: any, id?: number): Promise<any> {
    if (!this.child || !this.child.stdin) {
      return Promise.reject(new Error("Muse serve child not available"));
    }
    const req: any = { jsonrpc: "2.0", method, params };
    let promise: Promise<any> = Promise.resolve();
    if (id !== undefined) {
      req.id = id;
      promise = new Promise((resolve, reject) => {
        this.mspPendingRequests.set(id, { resolve, reject });
      });
    }
    this.child.stdin.write(JSON.stringify(req) + "\n");
    return promise;
  }

  private handleMspLine(line: string) {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && this.mspPendingRequests.has(msg.id)) {
        const { resolve, reject } = this.mspPendingRequests.get(msg.id)!;
        this.mspPendingRequests.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error.message || `MSP error: ${msg.error.code}`));
        } else {
          resolve(msg.result);
        }
        // Handle handshake completion
        if (msg.id === 1 && msg.result) {
          this.sendMsp("initialized", {});
          this.resolveInitialized();
        }
        return;
      }

      // Handle MSP streaming notifications
      this.handleMspNotification(msg.method, msg.params);
    } catch (err) {
      console.error("[muse-acp] Failed to parse MSP line:", err);
    }
  }

  private handleMspNotification(method: string, params: any) {
    if (!params) return;
    switch (method) {
      case "item/started": {
        const item = params.item;
        if (item && item.id) {
          this.itemKinds.set(item.id, item.kind);
          if (item.kind === "toolCall") {
            this.sendAcpNotification("session/update", {
              sessionId: this.activeSessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: item.id,
                title: item.title || item.name || "Tool",
                kind: "execute",
                status: "in_progress",
                rawInput: item.args || item.input,
              },
            });
          }
        }
        break;
      }
      case "item/delta": {
        const { itemId, delta } = params;
        if (!delta) break;
        const kind = this.itemKinds.get(itemId);
        if (kind === "reasoning") {
          this.sendAcpNotification("session/update", {
            sessionId: this.activeSessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: {
                type: "text",
                text: typeof delta === "string" ? delta : delta.text || "",
              },
            },
          });
        } else {
          this.sendAcpNotification("session/update", {
            sessionId: this.activeSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: typeof delta === "string" ? delta : delta.text || "",
              },
            },
          });
        }
        break;
      }
      case "item/completed": {
        const item = params.item;
        if (item && item.id && item.kind === "toolCall") {
          this.sendAcpNotification("session/update", {
            sessionId: this.activeSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: item.id,
              status: item.status === "failed" ? "failed" : "completed",
              content: item.result
                ? [
                    {
                      type: "text",
                      text:
                        typeof item.result === "string"
                          ? item.result
                          : JSON.stringify(item.result),
                    },
                  ]
                : [],
            },
          });
        }
        break;
      }
      case "turn/completed": {
        const usage = params.usage;
        if (usage) {
          this.sendAcpNotification("session/update", {
            sessionId: this.activeSessionId,
            update: {
              sessionUpdate: "usage_update",
              usage: {
                inputTokens: usage.inputTokens ?? usage.input_tokens ?? 0,
                outputTokens: usage.outputTokens ?? usage.output_tokens ?? 0,
                cacheReadTokens: usage.cacheReadTokens ?? usage.cache_read_tokens ?? 0,
                cacheWriteTokens: usage.cacheWriteTokens ?? usage.cache_write_tokens ?? 0,
              },
            },
          });
        }
        if (this.currentTurnResolver) {
          const stopReason =
            params.terminal === "cancelled" || params.terminal === "interrupted"
              ? "cancelled"
              : "end_turn";
          this.currentTurnResolver.resolve({ stopReason });
          this.currentTurnResolver = null;
        }
        break;
      }
      default:
        break;
    }
  }

  public sendAcpNotification(method: string, params: any) {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    process.stdout.write(JSON.stringify(notification) + "\n");
  }

  public sendAcpResponse(id: string | number | null, result?: any, error?: { code: number; message: string; data?: any }) {
    const res: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      ...(error ? { error } : { result: result ?? {} }),
    };
    process.stdout.write(JSON.stringify(res) + "\n");
  }

  public async handleAcpRequest(req: JsonRpcRequest) {
    const { id, method, params = {} } = req;
    try {
      switch (method) {
        case "initialize": {
          this.sendAcpResponse(id ?? null, {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: {
                image: true,
                embeddedContext: true,
              },
            },
            agentInfo: {
              name: "muse-acp",
              title: "Muse Code ACP Bridge",
              version: VERSION,
            },
          });
          break;
        }
        case "session/new": {
          const workspaceRoot = params.cwd || process.cwd();
          const startResult = await this.sendMsp(
            "session/start",
            {
              commandId: uuidv7(),
              workspaceRoot,
              approvalMode: "allowAll",
            },
            this.nextMspId++
          );
          const sessionId = startResult.session?.sessionId || startResult.sessionId;
          this.activeSessionId = sessionId;
          this.sendAcpResponse(id ?? null, { sessionId });
          break;
        }
        case "session/load": {
          const sessionId = params.sessionId;
          await this.sendMsp(
            "session/resume",
            { sessionId },
            this.nextMspId++
          );
          this.activeSessionId = sessionId;
          this.sendAcpResponse(id ?? null, { sessionId });
          break;
        }
        case "session/prompt": {
          const sessionId = params.sessionId;
          this.activeSessionId = sessionId;
          const inputParts: Array<{ type: string; text: string }> = [];
          if (Array.isArray(params.prompt)) {
            for (const part of params.prompt) {
              if (part.type === "text" && typeof part.text === "string") {
                inputParts.push({ type: "text", text: part.text });
              }
            }
          }
          if (inputParts.length === 0) {
            inputParts.push({ type: "text", text: "" });
          }

          const turnPromise = new Promise<{ stopReason: string }>((resolve, reject) => {
            this.currentTurnResolver = { resolve, reject };
          });

          await this.sendMsp(
            "turn/start",
            {
              commandId: uuidv7(),
              sessionId,
              input: inputParts,
            },
            this.nextMspId++
          );

          const turnResult = await turnPromise;
          this.sendAcpResponse(id ?? null, turnResult);
          break;
        }
        case "session/cancel": {
          if (this.activeSessionId) {
            await this.sendMsp(
              "turn/cancel",
              { sessionId: this.activeSessionId },
              this.nextMspId++
            ).catch(() => {});
          }
          if (id !== undefined && id !== null) {
            this.sendAcpResponse(id, { success: true });
          }
          break;
        }
        default: {
          if (id !== undefined && id !== null) {
            this.sendAcpResponse(id, undefined, {
              code: -32601,
              message: `Method not found: ${method}`,
            });
          }
          break;
        }
      }
    } catch (err) {
      console.error(`[muse-acp] Error handling ${method}:`, err);
      if (id !== undefined && id !== null) {
        this.sendAcpResponse(id, undefined, {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  public shutdown() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
  }
}

export async function main() {
  const { options, showVersion, showHelp } = parseArgs(process.argv);
  if (showVersion) {
    process.stdout.write(VERSION + "\n");
    process.exit(0);
  }
  if (showHelp) {
    process.stdout.write(`muse-acp — Agent Client Protocol bridge for Meta Muse Code

Usage: muse-acp [options]

Options:
  --provider <meta|local|echo>   Startup provider (default: meta)
  --model <model>                Model identifier (default: muse-spark-1.3)
  --reasoning-effort <effort>    Reasoning effort: none|minimal|low|medium|high|xhigh|max|ultra
  --command <path>               Path to muse executable (default: muse or ~/.local/bin/muse)
  --disable-sandbox              Disable OS sandboxing (default: true)
  --trust-workspace              Trust workspace root (default: true)
  -v, --version                  Print version and exit
  -h, --help                     Print help and exit
`);
    process.exit(0);
  }

  const bridge = new MuseAcpBridge(options);
  await bridge.start();

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const req = JSON.parse(line);
      bridge.handleAcpRequest(req);
    } catch (err) {
      console.error("[muse-acp] Malformed JSON from ACP client:", err);
    }
  });

  const cleanup = () => {
    bridge.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  rl.on("close", cleanup);
}

import { fileURLToPath } from "node:url";

const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main().catch((err) => {
    console.error("[muse-acp] Fatal error:", err);
    process.exit(1);
  });
}
