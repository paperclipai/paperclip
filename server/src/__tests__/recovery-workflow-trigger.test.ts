import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoveryWorkflowTrigger } from "../services/recovery-workflow-trigger.js";

const ACCOUNT_ID = "test-account-id";
const API_TOKEN = "test-api-token";
const WORKFLOW_NAME = "recovery-workflow";

const BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workflows/${WORKFLOW_NAME}/instances`;

function makeTrigger() {
  return recoveryWorkflowTrigger({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    workflowName: WORKFLOW_NAME,
  });
}

describe("recoveryWorkflowTrigger", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the correct Cloudflare Workflows REST endpoint", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: { id: "action-123" }, success: true }),
    });

    const trigger = makeTrigger();
    await trigger.ensureInstance({
      companyId: "company-1",
      actionId: "action-123",
      sourceIssueId: "issue-456",
      mode: "active",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(BASE_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    });

    const body = JSON.parse(init.body as string);
    expect(body.instance_id).toBe("action-123");
    expect(body.params).toMatchObject({
      companyId: "company-1",
      actionId: "action-123",
      sourceIssueId: "issue-456",
      mode: "active",
    });
  });

  it("returns instanceId from response on success", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: { id: "action-123" }, success: true }),
    });

    const trigger = makeTrigger();
    const result = await trigger.ensureInstance({
      companyId: "company-1",
      actionId: "action-123",
      sourceIssueId: "issue-456",
      mode: "active",
    });

    expect(result).toEqual({ instanceId: "action-123" });
  });

  it("resolves with { instanceId: actionId } on duplicate-id error (does NOT throw)", async () => {
    // Simulate Cloudflare returning an error for duplicate instance_id
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        errors: [{ code: 10006, message: "instance with id already exists" }],
      }),
    });

    const trigger = makeTrigger();
    const result = await trigger.ensureInstance({
      companyId: "company-1",
      actionId: "action-dupe",
      sourceIssueId: "issue-456",
      mode: "active",
    });

    expect(result).toEqual({ instanceId: "action-dupe" });
  });

  it("throws on unexpected non-duplicate error response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({
        success: false,
        errors: [{ code: 9999, message: "internal server error" }],
      }),
    });

    const trigger = makeTrigger();
    await expect(
      trigger.ensureInstance({
        companyId: "company-1",
        actionId: "action-abc",
        sourceIssueId: "issue-456",
        mode: "active",
      }),
    ).rejects.toThrow();
  });

  it("throws a clear error when config is missing required fields", () => {
    expect(() =>
      recoveryWorkflowTrigger({
        accountId: "",
        apiToken: API_TOKEN,
        workflowName: WORKFLOW_NAME,
      }),
    ).toThrow(/accountId/);
  });
});
