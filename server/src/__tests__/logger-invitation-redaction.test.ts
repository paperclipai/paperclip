import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHttpLogger } from "../middleware/logger.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";

describe("invitation bearer HTTP logs", () => {
  it.each([202, 400, 500].flatMap(status => ["Referer", "Referrer"].map(header => ({ status, header }))))("keeps bearer paths private in $status request records with $header", async ({ status, header }) => {
    const canary = "synthetic-invitation-bearer-canary";
    const chunks: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
    const app = express();
    app.use(createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream)));
    const router = express.Router();
    router.post("/invites/:token/accept", (_req, res) => res.status(status).end());
    app.use("/api", router);
    const response = await request(app).post(`/api/invites/${canary}/accept`).set(header, `https://board.example/invite/${canary}?source=email`);
    expect(response.status).toBe(status);
    const output = chunks.join("");
    expect(output).not.toContain(canary);
    const record = JSON.parse(output.trim());
    expect(record.req.method).toBe("POST");
    expect(record.req.url).toBe("/api/invites/[REDACTED]/accept");
    expect(record.req.headers[header.toLowerCase()]).toBe("https://board.example/invite/[REDACTED]");
    expect(record.res.statusCode).toBe(status);
    expect(record.msg).toContain(`POST /invites/[REDACTED]/accept ${status}`);
  });
});
