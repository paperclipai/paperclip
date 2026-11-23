import { describe, expect, it } from "vitest";
import { omitIssueUpdateEcho } from "./runner-api-update-echo.js";

const long = "x".repeat(501);
const call = { operationId: "PATCH /api/issues/{id}", pathParams: { id: "issue-a" }, body: { status: "done", comment: long } };
const response = {
  ok: true, status: 200, operationId: "PATCH /api/issues/{id}", contentType: "application/json",
  data: {
    id: "issue-a", status: "done", description: long, executionState: { status: "completed" },
    relatedWork: { outbound: [long], inbound: [] }, changes: { status: { from: "in_review", to: "done" } },
    comment: { id: "comment-a", body: long, createdAt: "2026-01-01T00:00:00.000Z" },
  },
};

describe("omitIssueUpdateEcho", () => {
  it("leaves out the repeated task text and keeps what the update changed", () => {
    expect(omitIssueUpdateEcho(response, call)).toEqual({
      ok: true, status: 200, operationId: "PATCH /api/issues/{id}", contentType: "application/json",
      data: {
        id: "issue-a", status: "done", executionState: { status: "completed" },
        changes: { status: { from: "in_review", to: "done" } },
        comment: { id: "comment-a", createdAt: "2026-01-01T00:00:00.000Z" },
      },
      omitted: { fields: ["description", "relatedWork", "comment.body"], guidance: expect.stringContaining("GET /api/issues/{id}/comments/{commentId}") },
    });
  });

  it("does not change the response it was given", () => {
    const before = structuredClone(response);
    omitIssueUpdateEcho(response, call);
    expect(response).toEqual(before);
  });

  it("keeps a comment that differs from the one the caller sent", () => {
    const result = omitIssueUpdateEcho({ ...response, data: { ...response.data, comment: { id: "comment-a", body: `${long}!` } } }, call);
    expect(result).toMatchObject({ data: { comment: { body: `${long}!` } }, omitted: { fields: ["description", "relatedWork"] } });
  });

  it.each([
    ["short values", { ...response, data: { id: "issue-a", description: "short", relatedWork: {}, comment: { body: "short" } } }],
    ["a failed update", { ...response, ok: false }],
    ["another operation", { ...response, operationId: "GET /api/issues/{id}" }],
    ["a response saved as an artifact", { ...response, data: undefined, artifact: { artifactId: "asset-a" } }],
    ["text data", { ...response, data: "text" }],
    ["no object", null],
  ])("returns %s unchanged", (_name, value) => {
    expect(omitIssueUpdateEcho(value, call)).toBe(value);
  });
});
