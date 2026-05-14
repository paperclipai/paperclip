import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { recordPlaceholderCapHit } from "../observability/prom.js";
import { metricsRoutes } from "../routes/metrics.js";

function createApp() {
  const app = express();
  app.use(metricsRoutes());
  return app;
}

describe("GET /metrics", () => {
  it("returns Prometheus text format", async () => {
    const res = await request(createApp()).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; version=0.0.4; charset=utf-8");
  });

  it("emits placeholder cap counter HELP and TYPE lines before increments", async () => {
    const res = await request(createApp()).get("/metrics");

    expect(res.text).toContain(
      "# HELP paperclip_placeholder_cap_hits_total Times the placeholder-comment cap blocked an agent comment post.",
    );
    expect(res.text).toContain("# TYPE paperclip_placeholder_cap_hits_total counter");
    expect(res.text).toContain(
      "# HELP paperclip_placeholder_cap_overrides_total Times a board override bypassed the placeholder-comment cap.",
    );
    expect(res.text).toContain("# TYPE paperclip_placeholder_cap_overrides_total counter");
  });

  it("emits agent_id-labelled samples after a placeholder cap hit", async () => {
    recordPlaceholderCapHit("test-agent");

    const res = await request(createApp()).get("/metrics");

    expect(res.text).toContain('paperclip_placeholder_cap_hits_total{agent_id="test-agent"} 1');
    expect(res.text).not.toContain("issue_id");
  });
});
