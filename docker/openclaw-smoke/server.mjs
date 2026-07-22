import http from "node:http";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const webhookPath = process.env.OPENCLAW_SMOKE_PATH?.trim() || "/webhook";
const expectedAuthHeader = process.env.OPENCLAW_SMOKE_AUTH?.trim() || "";
const maxBodyBytes = 1_000_000;
const maxEvents = 200;

const events = [];
let nextId = 1;

function writeJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function trimEvents() {
  if (events.length <= maxEvents) return;
  events.splice(0, events.length - maxEvents);
}

const server = http.createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  if (method === "GET" && url === "/health") {
    writeJson(res, 200, { ok: true, webhookPath, events: events.length });
    return;
  }

  if (method === "GET" && url === "/events") {
    writeJson(res, 200, { count: events.length, events });
    return;
  }

  if (method === "POST" && url === "/reset") {
    events.length = 0;
    writeJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && url === webhookPath) {
    const authorization = req.headers.authorization ?? "";
    if (expectedAuthHeader && authorization !== expectedAuthHeader) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    try {
      const raw = await readBody(req);
      let body = null;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        body = { raw };
      }

      const event = {
        id: `evt-${nextId++}`,
        receivedAt: new Date().toISOString(),
        method,
        path: url,
        authorizationPresent: Boolean(authorization),
        body,
      };
      events.push(event);
      trimEvents();
      writeJson(res, 200, { ok: true, received: true, eventId: event.id, count: events.length });
    } catch (err) {
      const code = err instanceof Error && err.message === "payload_too_large" ? 413 : 500;
      writeJson(res, code, { error: err instanceof Error ? err.message : "unknown_error" });
    }
    return;
  }

  writeJson(res, 404, { error: "not_found" });
});

server.listen(port, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`[openclaw-smoke] listening on :${port} path=${webhookPath}`);
});
