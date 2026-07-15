import { describe, expect, it, vi } from "vitest";
import {
  LINEAR_GRAPHQL_ENDPOINT,
  LinearEvidenceTransportError,
  createLinearEvidenceTransport,
  type LinearSecretResolver,
} from "./index.js";

const token = "lin_api_super-secret-value";
const secretRef = { type: "secret_ref" as const, secretId: "77777777-7777-4777-8777-777777777777", version: "latest" as const };
const marker = "<!-- paperclip-evidence:paperclip-evidence:v1:key:digest -->";

function jsonResponse(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

function harness(fetchImpl: typeof fetch) {
  const secretResolver = {
    resolve: vi.fn(async (_input: Parameters<LinearSecretResolver["resolve"]>[0]) => token),
  } satisfies LinearSecretResolver;
  return {
    secretResolver,
    transport: createLinearEvidenceTransport({
      authorizationSecretRef: secretRef,
      secretResolver,
      fetch: fetchImpl,
    }),
  };
}

describe("createLinearEvidenceTransport", () => {
  it("paginates a complete marker scan and injects the SecretRef value only into Authorization", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { issue: {
        id: "issue-uuid", identifier: "ALL-387",
        comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } },
      } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { issue: {
        id: "issue-uuid", identifier: "ALL-387",
        comments: {
          nodes: [{ id: "comment-1", body: `evidence\n${marker}`, createdAt: "2026-07-15T19:00:00.000Z", issue: { id: "issue-uuid", identifier: "ALL-387" } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      } } }));
    const { transport, secretResolver } = harness(fetchImpl);

    await expect(transport.findCommentByMarker({ linearIssueId: "ALL-387", marker })).resolves.toEqual({
      id: "comment-1",
      linearIssueId: "ALL-387",
      body: `evidence\n${marker}`,
      createdAt: "2026-07-15T19:00:00.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(LINEAR_GRAPHQL_ENDPOINT);
    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe(token);
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).not.toContain(token);
    expect(fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).variables.after)).toEqual([null, "cursor-1"]);
    expect(secretResolver.resolve).toHaveBeenCalledTimes(2);
    expect(secretResolver.resolve).toHaveBeenCalledWith({
      secretRef,
      purpose: "linear_evidence_comment_transport",
      operation: "find_comment",
    });
  });

  it("creates the exact body and performs a separate concrete comment read", async () => {
    const body = `completion evidence\n${marker}`;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { commentCreate: { success: true, comment: { id: "comment-2" } } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { comment: {
        id: "comment-2", body, createdAt: "2026-07-15T19:01:00.000Z", issue: { id: "issue-uuid", identifier: "ALL-387" },
      } } }));
    const { transport, secretResolver } = harness(fetchImpl);

    const created = await transport.createComment({ linearIssueId: "ALL-387", body });
    const receipt = await transport.getComment({ linearIssueId: "ALL-387", commentId: created.id });
    expect(receipt?.body).toBe(body);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).variables).toEqual({ linearIssueId: "ALL-387", body });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).variables).toEqual({ commentId: "comment-2" });
    expect(Object.keys(transport).sort()).toEqual(["createComment", "findCommentByMarker", "getComment"]);
    expect(Object.isFrozen(transport)).toBe(true);
    expect(secretResolver.resolve.mock.calls.map(([input]) => input.operation)).toEqual(["create_comment", "get_comment"]);
  });

  it("classifies a lost mutation response as ambiguous and redacts thrown credential text", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error(`socket failed with authorization=${token}`);
    });
    const { transport } = harness(fetchImpl);

    const error = await transport.createComment({ linearIssueId: "ALL-387", body: `safe evidence\n${marker}` }).catch((value) => value);
    expect(error).toBeInstanceOf(LinearEvidenceTransportError);
    expect(error.code).toBe("delivery_ambiguous");
    expect(JSON.stringify(error)).not.toContain(token);
    expect(String(error)).not.toContain(token);
  });

  it("does not retain secret-bearing resolver, HTTP, or GraphQL error messages", async () => {
    const resolverTransport = createLinearEvidenceTransport({
      authorizationSecretRef: secretRef,
      secretResolver: { resolve: async () => { throw new Error(`vault echoed ${token}`); } },
      fetch: vi.fn(),
    });
    const resolverError = await resolverTransport.getComment({ linearIssueId: "ALL-387", commentId: "comment-1" }).catch((value) => value);
    expect(resolverError.code).toBe("secret_resolution_failed");
    expect(`${String(resolverError)}${JSON.stringify(resolverError)}`).not.toContain(token);

    const { transport } = harness(vi.fn<typeof fetch>(async () => jsonResponse({
      errors: [{ message: `invalid ${token}`, extensions: { code: "AUTHENTICATION_ERROR" } }],
    }, { headers: { "x-request-id": "request-safe-1" } })));
    const remoteError = await transport.getComment({ linearIssueId: "ALL-387", commentId: "comment-1" }).catch((value) => value);
    expect(remoteError).toMatchObject({
      code: "remote_rejected",
      metadata: { requestId: "request-safe-1", remoteCode: "AUTHENTICATION_ERROR" },
    });
    expect(`${String(remoteError)}${JSON.stringify(remoteError)}`).not.toContain(token);
  });

  it("fails closed on duplicate markers, cross-issue receipts, and credential-like evidence", async () => {
    const duplicated = {
      id: "issue-uuid", identifier: "ALL-387",
      comments: {
        nodes: ["comment-1", "comment-2"].map((id) => ({
          id, body: marker, createdAt: "2026-07-15T19:00:00.000Z", issue: { id: "issue-uuid", identifier: "ALL-387" },
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    const duplicateHarness = harness(vi.fn<typeof fetch>(async () => jsonResponse({ data: { issue: duplicated } })));
    await expect(duplicateHarness.transport.findCommentByMarker({ linearIssueId: "ALL-387", marker }))
      .rejects.toMatchObject({ code: "remote_conflict" });

    const wrongIssueHarness = harness(vi.fn<typeof fetch>(async () => jsonResponse({ data: { comment: {
      id: "comment-1", body: marker, createdAt: "2026-07-15T19:00:00.000Z", issue: { id: "other", identifier: "ALL-999" },
    } } })));
    await expect(wrongIssueHarness.transport.getComment({ linearIssueId: "ALL-387", commentId: "comment-1" }))
      .rejects.toMatchObject({ code: "remote_conflict" });

    const fetchImpl = vi.fn<typeof fetch>();
    const unsafeHarness = harness(fetchImpl);
    await expect(unsafeHarness.transport.createComment({
      linearIssueId: "ALL-387",
      body: `Authorization: Bearer ${token}\n${marker}`,
    })).rejects.toMatchObject({ code: "unsafe_comment_body" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(unsafeHarness.secretResolver.resolve).not.toHaveBeenCalled();
  });

  it("rejects non-SecretRef and direct credential configuration before resolution or network access", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const secretResolver: LinearSecretResolver = { resolve: vi.fn(async () => token) };

    expect(() => createLinearEvidenceTransport({
      authorizationSecretRef: { secretId: secretRef.secretId } as never,
      secretResolver,
      fetch: fetchImpl,
    })).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    expect(() => createLinearEvidenceTransport({
      authorizationSecretRef: secretRef,
      secretResolver,
      fetch: fetchImpl,
      apiKey: token,
    } as never)).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(secretResolver.resolve).not.toHaveBeenCalled();
  });
});
