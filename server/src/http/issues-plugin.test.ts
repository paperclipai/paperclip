import { describe, expect, it } from "bun:test";
import { createProtectedHttpApp } from "./app.js";
import type { IssueRecord } from "./issues-plugin.js";
import { forbidden } from "../errors.js";

const board = {
  type: "board" as const,
  source: "local_implicit" as const,
  userId: "u1",
  isInstanceAdmin: true,
};

const issueRow: IssueRecord = { id: "i1", companyId: "c1", title: "Fix auth", status: "open" };
const issueRow2: IssueRecord = { id: "i2", companyId: "c1", title: "Second", status: "done" };
const commentRow = { id: "cm1", issueId: "i1", body: "added" };
const docRow = { key: "plan", issueId: "i1", title: "Plan" };
const wpRow = { id: "wp1", issueId: "i1" };

function issuesOpts(overrides: Record<string, unknown> = {}) {
  return {
    list: async () => [issueRow, issueRow2],
    getById: async (id: string) => (id === "i1" ? issueRow : id === "i2" ? issueRow2 : null),
    listComments: async () => [commentRow],
    createComment: async () => commentRow,
    listDocuments: async () => [docRow],
    getDocumentByKey: async (_i: string, key: string) => (key === "plan" ? docRow : null),
    listWorkProducts: async () => [wpRow],
    listExternalObjects: async () => [{ id: "eo1" }],
    getExternalObjectSummary: async () => ({ count: 1 }),
    ...overrides,
  };
}

describe("Elysia issues plugin", () => {
  it("lists issues with company access", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      issues: issuesOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1/issues"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([issueRow, issueRow2]);
  });

  it("gets an issue by id", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      issues: issuesOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/issues/i1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(issueRow);
  });

  it("returns 404 for cross-tenant issue get (no existence oracle)", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => ({
        type: "board" as const,
        source: "session" as const,
        userId: "u2",
        companyIds: ["other"],
      }),
      issues: issuesOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/issues/i1"));
    expect(response.status).toBe(404);
  });

  it("fails closed without actor", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => null,
      issues: issuesOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1/issues"));
    expect(response.status).toBe(401);
  });

  it("blocks cross-company list", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => ({
        type: "board" as const,
        source: "session" as const,
        userId: "u2",
        companyIds: ["other"],
      }),
      issues: issuesOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/companies/c1/issues"));
    expect(response.status).toBe(403);
  });

  it("lists comments after read gate", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      issues: issuesOpts(),
    });
    const response = await app.handle(new Request("http://localhost/api/issues/i1/comments"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([commentRow]);
  });

  it("creates a comment with 201", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      issues: issuesOpts(),
    });
    const response = await app.handle(
      new Request("http://localhost/api/issues/i1/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "hi", messageContext: { type: "text" } }),
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(commentRow);
  });

  it("lists documents and resolves a document by key", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      issues: issuesOpts(),
    });
    const list = await app.handle(new Request("http://localhost/api/issues/i1/documents"));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([docRow]);
    const one = await app.handle(new Request("http://localhost/api/issues/i1/documents/plan"));
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual(docRow);
    expect((await app.handle(new Request("http://localhost/api/issues/i1/documents/missing"))).status).toBe(404);
  });

  it("lists work-products and external objects", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      issues: issuesOpts(),
    });
    expect((await app.handle(new Request("http://localhost/api/issues/i1/work-products"))).status).toBe(200);
    expect((await app.handle(new Request("http://localhost/api/issues/i1/external-objects"))).status).toBe(200);
    expect((await app.handle(new Request("http://localhost/api/issues/i1/external-object-summary"))).status).toBe(200);
  });

  it("enforces assertCanMutate on comment create (403)", async () => {
    const app = createProtectedHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      resolveActor: () => board,
      issues: issuesOpts({
        assertCanMutate: async () => {
          throw forbidden("Mutation not allowed");
        },
      }),
    });
    const response = await app.handle(
      new Request("http://localhost/api/issues/i1/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "hi" }),
      }),
    );
    expect(response.status).toBe(403);
  });
});
