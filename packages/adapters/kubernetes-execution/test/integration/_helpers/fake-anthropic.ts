import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";

/**
 * Minimal fake of Anthropic's `/v1/messages` endpoint for the M2 Task 26
 * end-to-end test. Listens on a random localhost port and returns a single
 * deterministic assistant message. Anything other than `POST /v1/messages`
 * returns 404.
 *
 * The returned `url` uses `host.docker.internal` so a Pod inside kind can
 * reach the host. On Docker Desktop (macOS/Windows) this DNS name resolves
 * automatically. On Linux CI you may need a kind cluster config that adds
 * `extraPortMappings` + `--add-host=host.docker.internal:host-gateway`. See
 * the test's docstring for the workaround.
 *
 * `urlForLinux` is a fallback used when `host.docker.internal` does not
 * resolve: it picks the first non-loopback IPv4 on the host.
 */
export interface FakeAnthropic {
  /** URL the in-cluster client should hit. Uses `host.docker.internal`. */
  url: string;
  /** The host's primary non-loopback IPv4 (Linux fallback). */
  hostIp: string;
  /** The bound port. */
  port: number;
  stop(): Promise<void>;
}

export interface StartFakeAnthropicOptions {
  /** Override the assistant text returned. Default proves the round-trip. */
  assistantText?: string;
}

const DEFAULT_TEXT = "I read your prompt and I am alive.";

export async function startFakeAnthropic(
  options: StartFakeAnthropicOptions = {},
): Promise<FakeAnthropic> {
  const text = options.assistantText ?? DEFAULT_TEXT;
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/messages") {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          try {
            JSON.parse(body);
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad json" } }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: "msg_test_01",
              type: "message",
              role: "assistant",
              model: "claude-opus-4-7",
              content: [{ type: "text", text }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 8 },
            }),
          );
        });
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not_found" } }));
      }
    });
    // Bind 0.0.0.0 so kind's bridge network can reach us via host-gateway.
    server.listen(0, "0.0.0.0", () => {
      const addr = server.address() as { port: number };
      const port = addr.port;
      const hostIp = pickHostIp();
      resolve({
        url: `http://host.docker.internal:${port}`,
        hostIp,
        port,
        stop: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

function pickHostIp(): string {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}
