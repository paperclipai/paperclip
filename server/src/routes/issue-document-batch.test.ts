import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { registerIssueDocumentBatchRoute } from "./issue-document-batch.js";

vi.mock("../services/authorization.js", () => ({ issueReadSqlCondition: async () => undefined }));
vi.mock("../services/documents.js", () => ({
  ISSUE_DOCUMENT_BATCH_MAX_BYTES: 8 * 1024 * 1024,
  documentService: () => ({ getIssueDocumentsByKey: async () => [] }),
}));

const companyId = "11111111-1111-4111-8111-111111111111";
const url = `/api/companies/${companyId}/issue-documents?key=notes&issueIds=22222222-2222-4222-8222-222222222222`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const app = express(), router = express.Router();
  const entered: Array<() => void> = [];
  const gates: Array<ReturnType<typeof deferred<[]>>> = [];
  const pending: Array<Promise<request.Response>> = [];
  const db = { select: () => ({ from: () => ({ where: async () => [] }) }) } as unknown as Db;
  app.use((req, _res, next) => {
    req.actor = { type: "agent", companyId, agentId: req.header("actor")!, source: "agent_key" };
    next();
  });
  registerIssueDocumentBatchRoute(router, db, {
    filterReadable: async () => {
      const gate = deferred<[]>();
      gates.push(gate);
      entered.shift()!();
      return gate.promise;
    },
    recordReads: async () => undefined,
  });
  app.use("/api", router);
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: "test read failed" }); });
  return {
    app,
    async start(actor: string) {
      const signal = deferred<void>();
      entered.push(signal.resolve);
      const response = request(app).get(url).set("actor", actor).then(value => value);
      pending.push(response);
      await signal.promise;
      return { response, gate: gates.at(-1)! };
    },
    async close() {
      for (const gate of gates) gate.resolve([]);
      await Promise.allSettled(pending);
    },
  };
}

describe("bulk document read admission", () => {
  it("caps each actor and releases failed reads", async () => {
    const f = fixture();
    try {
      const first = await f.start("one"), second = await f.start("one");
      const refused = await request(f.app).get(url).set("actor", "one");
      expect(refused.status).toBe(429);
      expect(refused.headers["retry-after"]).toBe("1");
      first.gate.reject(new Error("read failed"));
      expect((await first.response).status).toBe(500);
      const replacement = await f.start("one");
      replacement.gate.resolve([]);
      second.gate.resolve([]);
      expect((await replacement.response).status).toBe(200);
    } finally { await f.close(); }
  });

  it("caps total reads across actors", async () => {
    const f = fixture();
    try {
      const reads = [];
      for (let index = 0; index < 8; index++) reads.push(await f.start(`actor-${index}`));
      expect((await request(f.app).get(url).set("actor", "ninth")).status).toBe(429);
      reads[0].gate.resolve([]);
      await reads[0].response;
      const replacement = await f.start("ninth");
      replacement.gate.resolve([]);
      expect((await replacement.response).status).toBe(200);
    } finally { await f.close(); }
  });
});
