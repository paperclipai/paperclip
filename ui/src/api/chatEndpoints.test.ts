import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("./client", () => ({ api: mockApi }));
import { chatEndpointsApi } from "./chatEndpoints";

describe("chatEndpointsApi", () => {
  beforeEach(() => Object.values(mockApi).forEach((mock) => mock.mockReset()));

  it("uses company-scoped creation and list routes", async () => {
    mockApi.get.mockResolvedValue({ endpoints: [] });
    mockApi.post.mockResolvedValue({ id: "endpoint-1" });
    await expect(chatEndpointsApi.list("company-1")).resolves.toEqual([]);
    await chatEndpointsApi.create("company-1", {
      provider: "slack",
      assignedAgentId: "agent-1",
    });
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/chat-endpoints",
    );
    expect(mockApi.post).toHaveBeenCalledWith(
      "/companies/company-1/chat-endpoints",
      { provider: "slack", assignedAgentId: "agent-1" },
    );
  });

  it("publishes a board message with a stable idempotency key", async () => {
    mockApi.post.mockResolvedValue(undefined);
    await chatEndpointsApi.publishBoardMessage(
      "endpoint-1",
      "conversation-1",
      "Visible update",
      "client-request-1234",
    );
    expect(mockApi.post).toHaveBeenCalledWith(
      "/chat-endpoints/endpoint-1/conversations/conversation-1/publications",
      {
        body: "Visible update",
        idempotencyKey: "client-request-1234",
      },
    );
  });

  it("posts provider credentials through the mounted setup action", async () => {
    mockApi.post.mockResolvedValue({ id: "endpoint-1", status: "verifying" });
    await chatEndpointsApi.setup("endpoint-1", {
      action: "configure",
      credentials: { appId: "123", privateKey: "pem" },
    });
    expect(mockApi.post).toHaveBeenCalledWith(
      "/chat-endpoints/endpoint-1/setup",
      {
        action: "configure",
        credentials: {
          appId: "123",
          privateKey: "pem",
        },
      },
    );
  });

  it("generates a one-time setup secret through the endpoint-scoped route", async () => {
    mockApi.post.mockResolvedValue({ webhookSecret: "generated-secret" });
    await expect(
      chatEndpointsApi.generateSetupSecret("endpoint-1"),
    ).resolves.toEqual({ webhookSecret: "generated-secret" });
    expect(mockApi.post).toHaveBeenCalledWith(
      "/chat-endpoints/endpoint-1/setup-secret",
      {},
    );
  });
});
