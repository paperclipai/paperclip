import express from "express";
import request from "supertest";
import { describe, it, expect } from "vitest";
import { buildApiRootHintHtml } from "../api-root-hint.js";

function createHintApp(opts: { deploymentMode: string; bindHost: string; uiBaseUrl?: string }) {
  const app = express();
  const html = buildApiRootHintHtml(opts);
  app.get(/.*/, (_req, res) => {
    res.status(200).set("Content-Type", "text/html").end(html);
  });
  return app;
}

describe("GET / in API-only mode (no UI served)", () => {
  it("returns 200 HTML for GET /", async () => {
    const app = createHintApp({ deploymentMode: "local_trusted", bindHost: "127.0.0.1" });
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("Paperclip API");
    expect(res.text).toContain("local_trusted");
    expect(res.text).toContain("127.0.0.1");
  });

  it("returns 200 HTML for any non-API path", async () => {
    const app = createHintApp({ deploymentMode: "local_trusted", bindHost: "127.0.0.1" });
    const res = await request(app).get("/some-random-path");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("Paperclip API");
  });

  it("includes a clickable UI link when uiBaseUrl is provided", async () => {
    const app = createHintApp({
      deploymentMode: "local_trusted",
      bindHost: "127.0.0.1",
      uiBaseUrl: "http://localhost:3000",
    });
    const res = await request(app).get("/");
    expect(res.text).toContain('href="http://localhost:3000"');
    expect(res.text).toContain("http://localhost:3000");
  });

  it("shows 'served separately' text when uiBaseUrl is not provided", async () => {
    const app = createHintApp({ deploymentMode: "local_trusted", bindHost: "127.0.0.1" });
    const res = await request(app).get("/");
    expect(res.text).toContain("served separately");
    expect(res.text).not.toContain('href="http://');
  });

  it("escapes HTML-special characters in inputs", async () => {
    const html = buildApiRootHintHtml({
      deploymentMode: "local_trusted",
      bindHost: "127.0.0.1",
      uiBaseUrl: 'http://example.com/?a=1&b=<script>',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;script&gt;");
  });
});
