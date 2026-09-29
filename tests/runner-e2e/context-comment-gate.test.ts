import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalDocumentIssueId, contextCommentGateSelected, holdCommittedDocumentResponse, release, waitUntilHeld } from "./context-comment-gate.js";

const express = createRequire(import.meta.url)("../../server/node_modules/express");

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("context comment gate", () => {
  it("selects only the ordered comment execution", () => {
    expect(contextCommentGateSelected(["context_integrity.runner-codex.ordered-comment-continuation"])).toBe(true);
    expect(contextCommentGateSelected(["context_integrity.runner-codex.assigned-skill-explicit-invocation"])).toBe(false);
  });

  it("uses the canonical issue ID returned by a successful document response", () => {
    expect(canonicalDocumentIssueId("/api/issues/RUN-1/documents/packing-report", JSON.stringify({ issueId: "issue-uuid" }))).toBe("issue-uuid");
    expect(canonicalDocumentIssueId("/api/issues/RUN-1/documents/packing-report", "not-json")).toBe("RUN-1");
    expect(canonicalDocumentIssueId("/api/issues/RUN-1/feedback", JSON.stringify({ issueId: "issue-uuid" }))).toBeUndefined();
  });

  it("holds a mounted Express document response using originalUrl", async () => {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    let observed: { url?: string; originalUrl?: string; issueId?: string } | undefined;
    let releaseResponse!: () => void;
    let observeHook!: () => void;
    const released = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const hookObserved = new Promise<void>((resolve) => { observeHook = resolve; });
    router.use((req: any, res: any, next: any) => {
      const originalEnd = res.end.bind(res);
      res.end = ((chunk?: any, ...rest: any[]) => {
        const originalUrl = (req as typeof req & { originalUrl?: string }).originalUrl;
        observed = { url: req.url, originalUrl, issueId: canonicalDocumentIssueId(req.url, chunk, originalUrl) };
        observeHook();
        if (observed.issueId) { void released.then(() => originalEnd(chunk, ...rest)); return res; }
        return originalEnd(chunk, ...rest);
      }) as typeof res.end;
      next();
    });
    router.put("/issues/:key/documents/:document", (_req: any, res: any) => res.status(201).json({ issueId: "issue-uuid" }));
    app.use("/api", router);
    const server = await new Promise<http.Server>((resolve) => {
      const value = app.listen(0, "127.0.0.1", () => resolve(value));
    });
    let responseSettled = false;
    try {
      const responsePromise = new Promise<number>((resolve, reject) => {
        const request = http.request({ host: "127.0.0.1", port: (server.address() as any).port, method: "PUT", path: "/api/issues/RUN-1/documents/report", headers: { "content-type": "application/json" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode ?? 0)); });
        request.on("error", reject);
        request.end(JSON.stringify({ issueId: "issue-uuid" }));
      });
      await hookObserved;
      expect(observed).toMatchObject({ url: "/issues/RUN-1/documents/report", originalUrl: "/api/issues/RUN-1/documents/report", issueId: "issue-uuid" });
      void responsePromise.then(() => { responseSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(responseSettled).toBe(false);
      releaseResponse();
      await expect(responsePromise).resolves.toBe(201);
    } finally {
      releaseResponse();
      if (!responseSettled) await new Promise((resolve) => setTimeout(resolve, 25));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("waits for a committed hold and releases it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-comment-gate-"));
    roots.push(root);
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_PRIVATE_DIR", root);
    const held = holdCommittedDocumentResponse("issue-1", Date.now() + 2_000);
    await waitUntilHeld("issue-1", Date.now() + 2_000);
    await release("issue-1");
    await expect(held).resolves.toBeUndefined();
    await expect(readFile(path.join(root, "context-comment-gates", "issue-1", "held"))).resolves.toBeTruthy();
    await expect(holdCommittedDocumentResponse("issue-1", Date.now() + 100)).resolves.toBeUndefined();
  });

  it("times out without release", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-comment-gate-"));
    roots.push(root);
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_PRIVATE_DIR", root);
    await expect(holdCommittedDocumentResponse("issue-1", Date.now() + 10)).rejects.toThrow("gate release");
  });
});
