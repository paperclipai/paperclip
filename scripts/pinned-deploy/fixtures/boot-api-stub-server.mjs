#!/usr/bin/env node
/**
 * Minimal HTTP stub for pinned-deploy snapshot boot/API smoke unit tests.
 * Speaks enough of /api/health and issues create/read for local_trusted smoke.
 * Not used in production cutover paths.
 */
import http from "node:http";

const port = Number(process.env.PORT || 0);
const host = process.env.HOST || "127.0.0.1";
const companyId = process.env.STUB_COMPANY_ID || "11111111-1111-4111-8111-111111111111";
const issues = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${host}:${port || 0}`);
  const send = (code, body) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(code, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  };

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(200, {
      status: "ok",
      deploymentMode: "local_trusted",
      bootstrapStatus: "ready",
      authReady: true,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/companies") {
    return send(200, [{ id: companyId, name: "Stub Smoke Co", issuePrefix: "SMOKE" }]);
  }

  const createMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/issues$/);
  if (req.method === "POST" && createMatch) {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return send(400, { error: "invalid json" });
      }
      if (!body.title) return send(400, { error: "title required" });
      const id = crypto.randomUUID();
      const issue = {
        id,
        companyId: createMatch[1],
        title: body.title,
        description: body.description ?? null,
        status: body.status || "backlog",
        identifier: `SMOKE-${issues.size + 1}`,
      };
      issues.set(id, issue);
      return send(201, issue);
    });
    return;
  }

  const getMatch = url.pathname.match(/^\/api\/issues\/([^/]+)$/);
  if (req.method === "GET" && getMatch) {
    const issue = issues.get(getMatch[1]);
    if (!issue) return send(404, { error: "not found" });
    return send(200, issue);
  }

  return send(404, { error: "not found", path: url.pathname });
});

server.listen(port, host, () => {
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  process.stdout.write(`stub-listening ${bound}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
