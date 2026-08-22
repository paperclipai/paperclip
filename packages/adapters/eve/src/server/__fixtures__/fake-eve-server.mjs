// Minimal fake Eve server used by local-runtime/local-execute tests.
// Listens on process.env.PORT (127.0.0.1) and serves just enough of the
// /eve/v1/* contract for one conversational turn.
import http from "node:http";

const port = Number(process.env.PORT ?? 0);

const streamEvents = [
  { type: "session.started", data: { sessionId: "fake-sess" } },
  { type: "message.completed", data: { text: "Fake turn complete.\nDetails.", finishReason: "stop" } },
  { type: "step.completed", data: { finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } } },
  { type: "turn.completed", data: {} },
  { type: "session.waiting", data: {} },
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/eve/v1/info") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "fake-eve", model: "fake-model" }));
    return;
  }
  if (req.method === "POST" && path === "/eve/v1/session") {
    res.writeHead(200, {
      "content-type": "application/json",
      "x-eve-session-id": "fake-sess",
    });
    res.end(JSON.stringify({ sessionId: "fake-sess", continuationToken: "fake-tok" }));
    return;
  }
  if (req.method === "POST" && /^\/eve\/v1\/session\/[^/]+$/.test(path)) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ continuationToken: "fake-tok-2" }));
    return;
  }
  if (req.method === "GET" && /^\/eve\/v1\/session\/[^/]+\/stream$/.test(path)) {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    for (const event of streamEvents) {
      res.write(`${JSON.stringify(event)}\n`);
    }
    res.end();
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `not found: ${req.method} ${path}` }));
});

server.listen(port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`fake-eve-server listening on ${port}`);
});
