import http from "node:http";
import { URL } from "node:url";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key?.startsWith("--")) {
    args.set(key.slice(2), value);
    index += 1;
  }
}

const host = args.get("host") || process.env.HERMES_OLLAMA_BRIDGE_HOST || "127.0.0.1";
const port = Number(args.get("port") || process.env.HERMES_OLLAMA_BRIDGE_PORT || "11435");
const target = new URL(args.get("target") || process.env.HERMES_OLLAMA_TARGET || "http://127.0.0.1:11434");

const server = http.createServer((clientReq, clientRes) => {
  const targetUrl = new URL(clientReq.url || "/", target);
  const proxyReq = http.request(
    targetUrl,
    {
      method: clientReq.method,
      headers: {
        ...clientReq.headers,
        host: target.host,
      },
    },
    (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(clientRes);
    },
  );

  proxyReq.on("error", (error) => {
    clientRes.writeHead(502, { "content-type": "application/json" });
    clientRes.end(JSON.stringify({ error: `Ollama bridge target failed: ${error.message}` }));
  });

  clientReq.pipe(proxyReq);
});

server.listen(port, host, () => {
  console.log(`Hermes Ollama bridge listening on http://${host}:${port}`);
  console.log(`Forwarding to ${target.href}`);
});
