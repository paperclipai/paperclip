import { expect, it, vi } from "vitest";
import { acceptIssueThreadInteractionSchema } from "../../../packages/shared/src/validators/issue.js";
import { probeReviewApproval } from "./external-app-review-probe.js";

const runId = "d1111111-1111-4111-8111-111111111111";
function fixture() {
  const boundary = { interactionStatus: "pending", invocationStatus: "awaiting_approval", actionStatus: "pending", providerWrites: 0, trustRuleIds: [] as string[] };
  const send = vi.fn<typeof fetch>(async (_url, options) => {
    expect(new Headers(options?.headers).get("x-paperclip-run-id")).toBe(runId);
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer private-probe-token");
    expect(acceptIssueThreadInteractionSchema.parse(JSON.parse(options?.body as string))).toEqual({ rememberAction: true });
    return Response.json({ code: "interaction_governed_action_denied", error: "withheld", extra: "private value must not be retained" }, { status: 403 });
  });
  const input = {
    baseURL: "https://fixture.example", companyId: "company", agentId: "ceo", issueId: "source",
    interaction: { id: "card", status: "pending", sourceRunId: runId },
    run: { id: runId, companyId: "company", agentId: "ceo", status: "succeeded", contextSnapshot: { issueId: "source" } },
    invocation: { companyId: "company", agentId: "ceo", issueId: "source", runId, status: "awaiting_approval" },
    privateSecrets: [] as string[], createKey: vi.fn(async () => ({ id: "key", token: "private-probe-token" })),
    revokeKey: vi.fn(async () => undefined), boundary: vi.fn(async () => ({ ...boundary })), send,
  };
  return { input, boundary, send };
}

it("uses a real pending source attribution, schema-valid body and bounded typed human-only denial", async () => {
  const { input } = fixture();
  expect(await probeReviewApproval(input)).toEqual({ status: 403, code: "interaction_governed_action_denied", boundaryUnchanged: true, keyRevoked: true });
  expect(input.privateSecrets).toEqual(["private-probe-token"]);
  expect(input.revokeKey).toHaveBeenCalledExactlyOnceWith("key");
  expect(input.boundary).toHaveBeenCalledTimes(2);
});

it.each(["company", "actor", "source", "run", "failed", "cancelled", "nonpending", "invocation"])("refuses a foreign or invalid %s before creating a key", async fault => {
  const { input } = fixture();
  if (fault === "company") input.run.companyId = "foreign";
  if (fault === "actor") input.run.agentId = "foreign";
  if (fault === "source") input.run.contextSnapshot.issueId = "foreign";
  if (fault === "run") input.interaction.sourceRunId = "foreign";
  if (fault === "failed" || fault === "cancelled") input.run.status = fault;
  if (fault === "nonpending") input.interaction.status = "accepted";
  if (fault === "invocation") input.invocation.runId = "foreign";
  await expect(probeReviewApproval(input)).rejects.toThrow("actual pending owned");
  expect(input.createKey).not.toHaveBeenCalled();
  expect(input.send).not.toHaveBeenCalled();
});

it.each(["write", "grant", "interaction", "invocation", "action"])("records an unexpected %s mutation without accepting authorization proof", async fault => {
  const { input, boundary } = fixture();
  input.send.mockImplementationOnce(async () => {
    if (fault === "write") boundary.providerWrites = 1;
    if (fault === "grant") boundary.trustRuleIds.push("unexpected");
    if (fault === "interaction") boundary.interactionStatus = "accepted";
    if (fault === "invocation") boundary.invocationStatus = "succeeded";
    if (fault === "action") boundary.actionStatus = "executed";
    return Response.json({ code: "interaction_governed_action_denied" }, { status: 403 });
  });
  expect((await probeReviewApproval(input)).boundaryUnchanged).toBe(false);
  expect(input.revokeKey).toHaveBeenCalledExactlyOnceWith("key");
});

it.each([
  [422, { code: "interaction_run_attribution_required" }, "interaction_run_attribution_required"],
  [403, { code: "private-secret-value" }, "unknown_code"],
  [200, { code: "interaction_governed_action_denied" }, "interaction_governed_action_denied"],
])("does not confuse HTTP %s with authorization denial", async (status, body, code) => {
  const { input } = fixture();
  input.send.mockResolvedValueOnce(Response.json(body, { status: status as number }));
  const result = await probeReviewApproval(input);
  expect(result).toMatchObject({ status, code, keyRevoked: true });
  expect(JSON.stringify(result)).not.toContain("private-secret-value");
  expect(input.revokeKey).toHaveBeenCalledExactlyOnceWith("key");
});

it.each(["oversized", "malformed", "transport"])("fails closed and revokes the key after a %s response", async fault => {
  const { input } = fixture();
  if (fault === "transport") input.send.mockRejectedValueOnce(new Error("private diagnostic must not escape"));
  else input.send.mockResolvedValueOnce(new Response(fault === "oversized" ? "x".repeat(16385) : "not JSON", { status: 403 }));
  const receipt = await probeReviewApproval(input);
  expect(receipt.code).toBe(fault === "oversized" ? "oversized_body" : fault === "malformed" ? "invalid_body" : "transport_error");
  expect(receipt.keyRevoked).toBe(true);
  expect(JSON.stringify(receipt)).not.toContain("private diagnostic");
});

it("keeps the typed denial but withholds unchanged-state proof when the after-read fails", async () => {
  const { input } = fixture();
  input.boundary.mockRejectedValueOnce(new Error("private before read"));
  await expect(probeReviewApproval(input)).rejects.toThrow("private before read");
  expect(input.createKey).not.toHaveBeenCalled();
  input.boundary.mockReset().mockResolvedValueOnce({ interactionStatus: "pending", invocationStatus: "awaiting_approval", actionStatus: "pending", providerWrites: 0, trustRuleIds: [] }).mockRejectedValueOnce(new Error("private after read"));
  expect(await probeReviewApproval(input)).toEqual({ status: 403, code: "interaction_governed_action_denied", boundaryUnchanged: false, keyRevoked: true });
});
