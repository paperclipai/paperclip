import { createServer, request as httpRequest } from "node:http";
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHttpLogger } from "../../middleware/logger.js";
import { HTTP_LOG_REDACT_PATHS } from "../../middleware/http-log-redaction.js";
import { isPrivateDotPrincipalHttpRequest } from "../../middleware/http-log-policy.js";

const bearer = "pcmcp_at_private_dot_log_canary";
const assertion = "private-dot-jws-log-canary";
const wire = Buffer.from(
  JSON.stringify({ accessToken: bearer, unexpected: assertion }),
);

function hasByteCopy(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return (
      (value.length > 0 && value.every((item) => typeof item === "number")) ||
      value.some(hasByteCopy)
    );
  }
  const object = value as Record<string, unknown>;
  return (
    object.type === "Buffer" ||
    Object.keys(object).some((key) => /^\d+$/.test(key)) ||
    Object.values(object).some(hasByteCopy)
  );
}

const cases = [
  { method: "POST", path: "/mcp/runner/oauth/cloud-principal", status: 200, mode: "plain" },
  {
    method: "POST",
    path: "/mcp/runner/oauth/cloud-principal",
    status: 401,
    mode: "plain",
  },
  {
    method: "POST",
    path: "/mcp/runner/oauth/cloud-principal/",
    status: 400,
    mode: "context",
  },
  {
    method: "GET",
    path: "/MCP/RUNNER/OAUTH/CLOUD-PRINCIPAL",
    status: 503,
    mode: "sdk",
  },
  {
    method: "DELETE",
    path:
      "http://upstream.invalid/mcp/runner/oauth/cloud-principal?token=" +
      bearer,
    status: 401,
    mode: "plain",
  },
  {
    method: "PUT",
    path: "/mcp/runner/oauth/cloud-principal%XX",
    status: 400,
    mode: "sdk",
  },
  {
    method: "PATCH",
    path: "/mcp/runner/oauth/%63loud-principal/",
    status: 503,
    mode: "context",
  },
] as const;

describe("Dot private principal actual HTTP logger boundary", () => {
  it.each(cases)(
    "keeps $method $path $mode status$status content-free",
    async (entry) => {
      expect(isPrivateDotPrincipalHttpRequest(entry.path)).toBe(true);
      const chunks: string[] = [];
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      });
      const app = express();
      app.use(express.raw({ type: "*/*" }));
      app.use(
        createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream)),
      );
      app.use((req, res) => {
        const sdkError = Object.assign(new Error(`${bearer} ${assertion}`), {
          name: assertion,
          request: { body: req.body, headers: { assertion } },
          response: { data: bearer },
        });
        if (entry.mode === "context") {
          Object.assign(res, {
            __errorContext: {
              error: sdkError,
              reqBody: req.body,
              reqParams: { private: bearer },
            },
          });
        }
        if (entry.mode !== "plain") Object.assign(res, { err: sdkError });
        res.setHeader("x-sdk-private", assertion);
        res.status(entry.status).end();
      });
      const server = createServer(app);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Missing owned logger listener");
        await new Promise<void>((resolve, reject) => {
          const client = httpRequest(
            {
              hostname: "127.0.0.1",
              port: address.port,
              method: entry.method,
              path: entry.path,
              headers: {
                "content-type": "application/json",
                "content-length": String(wire.length),
                "x-paperclip-cloud-control": assertion,
                "x-sdk-private": bearer,
              },
            },
            (response) => {
              expect(response.statusCode).toBe(entry.status);
              response.resume();
              response.on("end", resolve);
              response.on("error", reject);
            },
          );
          client.on("error", reject);
          client.end(wire);
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      const output = chunks.join("");
      expect(output).not.toContain(bearer);
      expect(output).not.toContain(assertion);
      const logs = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(logs).toHaveLength(1);
      const log = logs[0];
      if (entry.status >= 400) expect(log.reqBody).toBe("[REDACTED]");
      else expect(log.reqBody).toBeUndefined();
      expect(log.req.url).toBe("/mcp/runner/oauth/cloud-principal");
      expect(log.req.body).toBeUndefined();
      expect(log.req.headers).toBeUndefined();
      expect(log.req.params).toBeUndefined();
      expect(log.req.query).toBeUndefined();
      expect(log.res.headers).toBeUndefined();
      expect(hasByteCopy(log)).toBe(false);
      if (entry.mode !== "plain") {
        expect(log.err.message).toBe("Dot principal request failed");
        expect(log.err.request).toBeUndefined();
      }
    },
  );

  it.each(["/mcp/oauth/token", "/mcp/paperclip"])(
    "preserves existing MCP raw failure redaction at %s",
    async (path) => {
      const chunks: string[] = [];
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      });
      const app = express();
      app.use(express.raw({ type: "*/*" }));
      app.use(
        createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream)),
      );
      app.use((_req, res) => res.status(400).end());
      await request(app)
        .post(path)
        .set("Content-Type", "application/json")
        .send(wire);
      const output = chunks.join("");
      expect(output).not.toContain(bearer);
      expect(JSON.parse(output.trim()).reqBody).toBe("[REDACTED]");
      expect(hasByteCopy(JSON.parse(output.trim()))).toBe(false);
    },
  );
});
