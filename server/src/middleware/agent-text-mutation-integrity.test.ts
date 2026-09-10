import { createHash } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  agentTextMutationContentType,
  agentTextMutationIntegrity,
  captureAndValidateAgentTextMutationBody,
} from "./agent-text-mutation-integrity.js";

async function sendRaw(app: express.Express, method: "POST" | "PATCH", path: string, body: Buffer, digest: string) {
  const server = app.listen();
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  try {
    return await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = httpRequest({ method, port, path, headers: { "Content-Type": "application/json; charset=utf-8", "Content-Digest": `sha-256=:${digest}:`, "Content-Length": body.length } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      req.on("error", reject);
      req.end(body);
    });
  } finally {
    server.close();
  }
}

describe("agentTextMutationContentType", () => {
  it("rejects a Windows-1252 agent body before express.json can return 415 or reach persistence", async () => {
    const app = express();
    let persisted = 0;
    const body = Buffer.from('{"body":"????????"}', "ascii");
    const digest = createHash("sha256").update(body).digest("base64");

    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_api_key" } as any;
      next();
    });
    // This is the production order in createApp: auth, content-type gate,
    // JSON parser, then raw-byte and semantic integrity checks.
    app.use(agentTextMutationContentType);
    app.use(express.json({ verify: (req, _res, raw) => captureAndValidateAgentTextMutationBody(req, raw) }));
    app.use(agentTextMutationIntegrity);
    app.post("/api/issues/1/comments", (_req, res) => {
      persisted += 1;
      res.status(201).json({ body: "unexpected" });
    });

    const response = await request(app)
      .post("/api/issues/1/comments")
      .set("Content-Type", "application/json; charset=windows-1252")
      .set("Content-Digest", `sha-256=:${digest}:`)
      .send(body);

    expect(response.status).toBe(428);
    expect(persisted).toBe(0);
  });

  it("rejects malformed UTF-8 with a matching digest before JSON decoding or persistence", async () => {
    const app = express();
    let persisted = 0;
    const body = Buffer.concat([Buffer.from('{"body":"', "ascii"), Buffer.from([0xc3, 0x28]), Buffer.from('"}', "ascii")]);
    const digest = createHash("sha256").update(body).digest("base64");

    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_api_key" } as any;
      next();
    });
    app.use(agentTextMutationContentType);
    app.use(express.json({ verify: (req, _res, raw) => captureAndValidateAgentTextMutationBody(req, raw) }));
    app.use(agentTextMutationIntegrity);
    app.post("/api/issues/1/comments", (_req, res) => {
      persisted += 1;
      res.status(201).json({ body: "unexpected" });
    });
    app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message });
    });

    const response = await sendRaw(app, "POST", "/api/issues/1/comments", body, digest);

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("valid UTF-8");
    expect(persisted).toBe(0);
  });

  it("rejects nested U+FFFD and loss markers before persistence while preserving valid multilingual UTF-8", async () => {
    const app = express();
    const persisted: unknown[] = [];
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_api_key" } as any;
      next();
    });
    app.use(agentTextMutationContentType);
    app.use(express.json({ verify: (req, _res, raw) => captureAndValidateAgentTextMutationBody(req, raw) }));
    app.use(agentTextMutationIntegrity);
    app.patch("/api/issues/1", (req, res) => {
      persisted.push(req.body);
      res.status(200).json(req.body);
    });

    const corrupted = Buffer.from(JSON.stringify({ comment: { body: "bad \uFFFD text" } }), "utf8");
    const lossy = Buffer.from(JSON.stringify({ comment: { body: "????????" } }), "utf8");
    const valid = Buffer.from(JSON.stringify({ comment: { body: "Привет, 中文, 日本語" } }), "utf8");
    const corruptedResponse = await sendRaw(app, "PATCH", "/api/issues/1", corrupted, createHash("sha256").update(corrupted).digest("base64"));
    const lossyResponse = await sendRaw(app, "PATCH", "/api/issues/1", lossy, createHash("sha256").update(lossy).digest("base64"));
    const validResponse = await sendRaw(app, "PATCH", "/api/issues/1", valid, createHash("sha256").update(valid).digest("base64"));

    expect(corruptedResponse.status).toBe(422);
    expect(lossyResponse.status).toBe(422);
    expect(validResponse.status).toBe(200);
    expect(validResponse.body).toEqual({ comment: { body: "Привет, 中文, 日本語" } });
    expect(persisted).toEqual([{ comment: { body: "Привет, 中文, 日本語" } }]);
  });
});
