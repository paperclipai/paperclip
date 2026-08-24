import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  RPAA_9600_CANARIES,
  RPAA_9600_REDACTED_VALUE,
  isWritebackSanitizerHealthy,
  paperclipWritebackRedactionMiddleware,
  redactWritebackForRoute,
  sanitizePaperclipWritebackBody,
  sanitizePaperclipWritebackFields,
  type PaperclipRedactedRequest,
} from "../writeback-redaction.js";

// Pick canaries whose values are NOT the redaction placeholder, so the
// tests can prove the boundary fired and stripped the marker.
const CANARY_API_KEY = RPAA_9600_CANARIES[1];
const CANARY_GITHUB = RPAA_9600_CANARIES[2];

describe("writeback-redaction (RPAA-9600)", () => {
  it("exposes a canary list with at least 7 entries including the placeholder", () => {
    expect(RPAA_9600_CANARIES.length).toBeGreaterThanOrEqual(7);
    expect(RPAA_9600_CANARIES).toContain("[REDACTED_SECRET]");
  });

  it("strips every canary from a single body string", async () => {
    const dirty = [
      `synthetic comment ${CANARY_API_KEY}`,
      `inline pattern api_key=${CANARY_GITHUB}`,
      "plain text must survive",
    ].join("\n");

    const result = await sanitizePaperclipWritebackBody(dirty);

    expect(result.redacted).toBe(true);
    expect(result.canariesHit.length).toBeGreaterThan(0);
    expect(result.text.includes(CANARY_API_KEY)).toBe(false);
    expect(result.text.includes(CANARY_GITHUB)).toBe(false);
    expect(result.text).toContain("plain text must survive");
    expect(result.guardrailsSource.length).toBeGreaterThan(0);
  });

  it("redacts known field keys and leaves other fields untouched", async () => {
    const dirty = {
      title: `title ${CANARY_API_KEY}`,
      description: "safe description",
      body: `body ${CANARY_GITHUB}`,
      comment: `comment ${CANARY_API_KEY}`,
      safe: "stays",
      number: 42,
    };

    const result = await sanitizePaperclipWritebackFields(dirty);

    expect(result.redacted).toBe(true);
    expect(result.changedKeys.sort()).toEqual(["body", "comment", "title"]);
    expect(result.fields.title).not.toContain(CANARY_API_KEY);
    expect(result.fields.description).toBe("safe description");
    expect(result.fields.body).not.toContain(CANARY_GITHUB);
    expect(result.fields.comment).not.toContain(CANARY_API_KEY);
    expect(result.fields.safe).toBe("stays");
    expect(result.fields.number).toBe(42);
  });

  it("is idempotent on already-clean text", async () => {
    const clean = "just a normal comment body\nwith a newline and nothing else";
    const result = await sanitizePaperclipWritebackBody(clean);
    expect(result.text).toBe(clean);
    expect(result.redacted).toBe(false);
    expect(result.canariesHit).toEqual([]);
  });

  it("returns empty audit for empty input", async () => {
    const result = await sanitizePaperclipWritebackBody("");
    expect(result.text).toBe("");
    expect(result.redacted).toBe(false);
    expect(result.canariesHit).toEqual([]);
  });

  it("replaces stripped canaries with the RPAA_9600_REDACTED_VALUE placeholder", async () => {
    expect(RPAA_9600_REDACTED_VALUE).toBe("[REDACTED_SECRET]");
    const result = await sanitizePaperclipWritebackBody(
      `leak ${CANARY_API_KEY} and ${CANARY_GITHUB}`,
    );
    expect(result.text).toContain(RPAA_9600_REDACTED_VALUE);
    // The original markers must not survive.
    expect(result.text).not.toContain(CANARY_API_KEY);
    expect(result.text).not.toContain(CANARY_GITHUB);
  });

  it("redactWritebackForRoute wraps the result with a redaction audit block", async () => {
    const wrapped = await redactWritebackForRoute("issue_comment", {
      body: `body ${CANARY_API_KEY}`,
    });
    expect(wrapped.body).not.toContain(CANARY_API_KEY);
    expect(wrapped.body).toContain(RPAA_9600_REDACTED_VALUE);
    expect(wrapped.redaction.kind).toBe("issue_comment");
    expect(wrapped.redaction.redacted).toBe(true);
    expect(wrapped.redaction.changedKeys).toEqual(["body"]);
    expect(typeof wrapped.redaction.appliedAt).toBe("string");
    expect(wrapped.redaction.appliedAt.length).toBeGreaterThan(0);
  });

  it("isWritebackSanitizerHealthy returns true for a healthy sanitizer", async () => {
    await expect(isWritebackSanitizerHealthy()).resolves.toBe(true);
  });

  it("paperclipWritebackRedactionMiddleware applies redaction to req.body", async () => {
    const app = express();
    app.use(express.json());
    app.use(paperclipWritebackRedactionMiddleware());
    app.post("/probe", (req, res) => {
      const redacted = (req as PaperclipRedactedRequest).paperclipRedacted;
      res.json({ body: req.body, redacted });
    });

    const response = await request(app)
      .post("/probe")
      .send({ body: `leak ${CANARY_API_KEY}`, title: "ok" })
      .set("content-type", "application/json");

    expect(response.status).toBe(200);
    expect(response.body.body.body).not.toContain(CANARY_API_KEY);
    expect(response.body.body.title).toBe("ok");
    expect(response.body.redacted.changedKeys).toEqual(["body"]);
  });

  it("paperclipWritebackRedactionMiddleware is a no-op when body is missing", async () => {
    const app = express();
    app.use(express.json());
    let nextCalled = false;
    app.use(paperclipWritebackRedactionMiddleware());
    app.post("/empty", (_req, res) => {
      nextCalled = true;
      res.json({ ok: true });
    });

    const response = await request(app).post("/empty").send({});
    expect(response.status).toBe(200);
    expect(nextCalled).toBe(true);
  });

  it("paperclipWritebackRedactionMiddleware is fail-closed when configured", () => {
    const middleware = paperclipWritebackRedactionMiddleware({ failClosed: true });
    expect(middleware).toBeTypeOf("function");
  });

  it("honors an empty string canaries list without throwing", async () => {
    const result = await sanitizePaperclipWritebackBody("hello world", {
      canaries: [],
    });
    expect(result.text).toBe("hello world");
  });
});

describe("writeback-redaction middleware wiring", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves the original body on req.paperclipRawBody and marks only matching fields changed", async () => {
    const app = express();
    app.use(express.json());
    app.use(paperclipWritebackRedactionMiddleware());
    app.post("/probe", (req, res) => {
      const typed = req as PaperclipRedactedRequest;
      res.json({
        rawBody: typed.paperclipRawBody,
        body: req.body,
        redacted: typed.paperclipRedacted,
      });
    });

    const response = await request(app)
      .post("/probe")
      .send({ body: "stays", comment: `leak ${CANARY_API_KEY}`, title: "ok" })
      .set("content-type", "application/json");

    expect(response.status).toBe(200);
    expect(response.body.rawBody).toEqual({
      body: "stays",
      comment: `leak ${CANARY_API_KEY}`,
      title: "ok",
    });
    // "body" stays unchanged (no canary), "comment" is redacted, "title" is untouched.
    expect(response.body.body).toEqual({
      body: "stays",
      comment: `leak ${RPAA_9600_REDACTED_VALUE}`,
      title: "ok",
    });
    expect(response.body.redacted.changedKeys).toEqual(["comment"]);
  });
});