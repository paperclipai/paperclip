import type { Db } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubBotCredentials } from "./chat-github-client.js";
import { githubChatManagementService } from "./chat-github-management.js";

vi.mock("./chat-github-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./chat-github-client.js")>(),
  githubBotCredentials: vi.fn(),
}));
vi.mock("./secrets.js", () => ({ secretService: vi.fn() }));
vi.mock("./tool-access-policy.js", () => ({ toolAccessPolicyService: vi.fn() }));
vi.mock("./chat-github-tools.js", () => ({ GITHUB_BOT_TOOLS: [], syncGitHubBotTools: vi.fn() }));
vi.mock("./tool-access.js", () => ({ toolAccessService: vi.fn() }));
vi.mock("./activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("./environments.js", () => ({ environmentService: vi.fn() }));
vi.mock("./instance-settings.js", () => ({ instanceSettingsService: vi.fn() }));
vi.mock("./execution-workspace-policy.js", () => ({ resolveExecutionWorkspaceEnvironmentId: vi.fn() }));

const endpoint = { id: "bot-endpoint", companyId: "bot-company", status: "active" };
const credentials = {
  endpoint,
  connection: { enabled: true, status: "active" },
  credentials: { installationId: "12345" },
  appJwt: "app-jwt-not-for-users",
};

function fixture(user: unknown = { id: 1, login: "octocat", type: "User" }) {
  const where = vi.fn().mockResolvedValue([endpoint]);
  const db = { select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })) } as unknown as Db;
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ token: "installation-token-not-for-output" }, { status: 201 }))
    .mockResolvedValueOnce(Response.json(user));
  const service = githubChatManagementService(db, fetchImpl);
  return { db, where, fetchImpl, service };
}

describe("GitHub external contributor lookup", () => {
  beforeEach(() => {
    vi.mocked(githubBotCredentials).mockReset();
    vi.mocked(githubBotCredentials).mockResolvedValue(credentials as never);
  });

  it("uses only the requested endpoint's installation with metadata permission", async () => {
    const { db, fetchImpl, service } = fixture();
    expect(await service.lookupPerson(endpoint.id, "octocat")).toEqual({ githubUserId: "1", login: "octocat" });
    expect(githubBotCredentials).toHaveBeenCalledExactlyOnceWith(db, endpoint.companyId, endpoint.id);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]).toEqual([
      "https://api.github.com/app/installations/12345/access_tokens",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({ authorization: "Bearer app-jwt-not-for-users" }),
        body: JSON.stringify({ permissions: { metadata: "read" } }),
      }),
    ]);
    expect(fetchImpl.mock.calls[1]).toEqual([
      "https://api.github.com/users/octocat",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: expect.objectContaining({ authorization: "Bearer installation-token-not-for-output" }),
      }),
    ]);
  });

  it("accepts bot accounts and keeps the numeric identity", async () => {
    const { fetchImpl, service } = fixture({ id: 9001, login: "reviewer[bot]", type: "Bot" });
    expect(await service.lookupPerson(endpoint.id, "reviewer[bot]")).toEqual({ githubUserId: "9001", login: "reviewer[bot]" });
    expect(fetchImpl.mock.calls[1][0]).toBe("https://api.github.com/users/reviewer%5Bbot%5D");
  });

  it.each(["../someone", "https://github.com/someone", "", "-name"])("rejects invalid login %j before credentials or network access", async (login) => {
    const { fetchImpl, service } = fixture();
    await expect(service.lookupPerson(endpoint.id, login)).rejects.toMatchObject({ status: 400 });
    expect(githubBotCredentials).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not use another endpoint when the requested bot is absent", async () => {
    const { fetchImpl, where, service } = fixture();
    where.mockResolvedValue([]);
    await expect(service.lookupPerson(endpoint.id, "octocat")).rejects.toMatchObject({ status: 404 });
    expect(githubBotCredentials).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { connection: { enabled: false, status: "active" } },
    { connection: { enabled: true, status: "revoked" } },
    { endpoint: { ...endpoint, status: "draft" } },
    { endpoint: { ...endpoint, status: "paused" } },
  ])("rejects inactive installation state %j without anonymous fallback", async (state) => {
    const { fetchImpl, service } = fixture();
    vi.mocked(githubBotCredentials).mockResolvedValue({ ...credentials, ...state } as never);
    await expect(service.lookupPerson(endpoint.id, "octocat")).rejects.toMatchObject({ status: 409 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["", "not-an-installation", "123/../../users"])("requires a valid saved installation ID %j", async (installationId) => {
    const { fetchImpl, service } = fixture();
    vi.mocked(githubBotCredentials).mockResolvedValue({ ...credentials, credentials: { installationId } } as never);
    await expect(service.lookupPerson(endpoint.id, "octocat")).rejects.toMatchObject({ status: 409 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires an issued token before it looks up a person", async () => {
    const { fetchImpl, service } = fixture();
    fetchImpl.mockReset().mockResolvedValue(Response.json({}));
    await expect(service.lookupPerson(endpoint.id, "octocat")).rejects.toMatchObject({ status: 422, message: expect.stringContaining("did not issue") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { id: 1, login: "org", type: "Organization" },
    { id: "1", login: "octocat", type: "User" },
    { id: 0, login: "octocat", type: "User" },
    { id: 1, type: "User" },
  ])("rejects accounts without a valid person identity: %j", async (user) => {
    const { service } = fixture(user);
    await expect(service.lookupPerson(endpoint.id, "octocat")).rejects.toMatchObject({ status: 400, message: "Choose a GitHub person or bot account" });
  });

  it.each([403, 429])("reports HTTP %s rate limits and preserves retry metadata", async (status) => {
    const { fetchImpl, service } = fixture();
    fetchImpl.mockReset()
      .mockResolvedValueOnce(Response.json({ token: "installation-token-not-for-output" }))
      .mockResolvedValueOnce(Response.json({ message: "secret-provider-response" }, { status, headers: { "retry-after": "60", "x-ratelimit-remaining": "0" } }));
    await expect(service.lookupPerson(endpoint.id, "octocat")).rejects.toMatchObject({
      message: expect.stringContaining("rate limit"),
      details: { code: "github_bot_rate_limited", providerStatus: status, retryable: true, retryAfterMs: 60000 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("distinguishes an unavailable account from an invalid installation", async () => {
    const { fetchImpl, service } = fixture();
    fetchImpl.mockReset()
      .mockResolvedValueOnce(Response.json({ token: "installation-token-not-for-output" }))
      .mockResolvedValueOnce(Response.json({ message: "secret-provider-response" }, { status: 404 }));
    await expect(service.lookupPerson(endpoint.id, "octocat")).rejects.toMatchObject({
      status: 400, message: expect.stringContaining("Check the username"), details: { providerStatus: 404 },
    });
  });

  it.each([401, 403, 404])("reports installation HTTP %s without a user lookup or provider response text", async (status) => {
    const { fetchImpl, service } = fixture();
    fetchImpl.mockReset().mockResolvedValue(Response.json({ message: "secret-provider-response" }, { status }));
    const error = await service.lookupPerson(endpoint.id, "octocat").catch((error: Error) => error);
    expect(error).toMatchObject({ status: 422, message: expect.stringContaining("installation"), details: { providerStatus: status, retryable: false } });
    expect(JSON.stringify(error)).not.toContain("secret-provider-response");
    expect(JSON.stringify(error)).not.toContain("app-jwt-not-for-users");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
