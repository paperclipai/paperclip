/**
 * Dual-mode MCP transport runner (ported from plugins/honcho/src/mcp/runner.ts).
 *
 * A single MCP server definition can be served two ways:
 *
 *   --stdio (default)  one process per launch, scoped by a config derived from
 *                      the process environment. Ideal for per-turn harness spawns.
 *   --http  --port N   a Node HTTP server that resolves a fresh, per-request
 *                      config (typically from a bearer token). For multi-tenant
 *                      external exposure behind an auth gate.
 *
 * The runner is generic over the config type `TConfig`: the caller supplies how
 * to build a server from a config, how to derive a config from the environment
 * (stdio), and how to authenticate a request into a config (http).
 */
import http from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { messageForError, statusForError } from "./errors.js";

/** Minimal shape of an MCP server instance the runner needs. */
export interface McpServerLike {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface TransportRunner<TConfig> {
  /** Build a fresh MCP server instance for a resolved config. */
  buildServer: (config: TConfig) => McpServerLike | Promise<McpServerLike>;
  /** Resolve a config from the process environment (stdio mode). */
  configFromEnv: () => TConfig | Promise<TConfig>;
  /** Authenticate/resolve a per-request config (http mode). Throw to reject. */
  authenticate: (req: http.IncomingMessage) => TConfig | Promise<TConfig>;
  /** Short label used in the stderr ready log. Defaults to "mcp". */
  name?: string;
  /** Optional one-line summary of a config for the stdio ready log. */
  describeConfig?: (config: TConfig) => string;
}

export interface HttpRunOptions {
  port: number;
  /** Bind host. Defaults to 127.0.0.1 (loopback-only; front with a proxy). */
  host?: string;
}

const DEFAULT_HOST = "127.0.0.1";

/** Run the server over stdio, scoping identity from the environment. */
export async function runStdio<TConfig>(runner: TransportRunner<TConfig>): Promise<void> {
  const config = await runner.configFromEnv();
  const server = await runner.buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const label = runner.name ?? "mcp";
  const detail = runner.describeConfig ? ` · ${runner.describeConfig(config)}` : "";
  console.error(`[${label}] stdio ready${detail}`);
}

/**
 * Run the server over HTTP. Each request is authenticated into its own config
 * and gets a fresh, per-request MCP server + transport pair (stateless mode:
 * `sessionIdGenerator: undefined`), which are torn down when the socket closes.
 * Resolves with the listening {@link http.Server} once bound.
 */
export async function runHttp<TConfig>(
  runner: TransportRunner<TConfig>,
  options: HttpRunOptions,
): Promise<http.Server> {
  const host = options.host ?? DEFAULT_HOST;
  const label = runner.name ?? "mcp";

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");

    let config: TConfig;
    try {
      config = await runner.authenticate(req);
    } catch (e) {
      const status = statusForError(e, 401);
      if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: messageForError(e, "unauthorized") }));
      return;
    }

    let mcp: McpServerLike | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      mcp = await runner.buildServer(config);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const activeMcp = mcp;
      const activeTransport = transport;
      res.on("close", () => {
        void activeTransport.close();
        void activeMcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: messageForError(e, "internal error") }));
      void transport?.close();
      void mcp?.close();
    }
  });

  return await new Promise<http.Server>((resolve) => {
    server.listen(options.port, host, () => {
      console.error(`[${label}] http ready on http://${host}:${options.port}`);
      resolve(server);
    });
  });
}

export interface ParsedTransportArgs {
  mode: "stdio" | "http";
  port: number;
  host?: string;
}

/**
 * Parse transport selection from argv (and PORT env).
 *   --http           select http mode (default is stdio)
 *   --stdio          select stdio mode explicitly
 *   --port <n>       http port (env PORT wins if set)
 *   --host <h>       http bind host
 */
export function parseTransportArgv(
  argv: string[],
  defaults: { port?: number; env?: NodeJS.ProcessEnv } = {},
): ParsedTransportArgs {
  const env = defaults.env ?? process.env;
  const mode: "stdio" | "http" = argv.includes("--http") ? "http" : "stdio";

  const portIdx = argv.indexOf("--port");
  const portArg = portIdx >= 0 ? argv[portIdx + 1] : undefined;
  const hostIdx = argv.indexOf("--host");
  const host = hostIdx >= 0 ? argv[hostIdx + 1] : undefined;

  const port = Number(env.PORT || portArg || defaults.port || 8788);
  return { mode, port, host };
}

/** Convenience: parse argv and dispatch to {@link runStdio}/{@link runHttp}. */
export async function runFromArgv<TConfig>(
  runner: TransportRunner<TConfig>,
  argv: string[] = process.argv.slice(2),
  defaults: { port?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const parsed = parseTransportArgv(argv, defaults);
  if (parsed.mode === "http") {
    await runHttp(runner, { port: parsed.port, host: parsed.host });
  } else {
    await runStdio(runner);
  }
}
