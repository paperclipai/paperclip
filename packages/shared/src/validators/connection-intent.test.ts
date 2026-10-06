import { describe, expect, it } from "vitest";
import {
  connectionIntentPayloadSchema,
  connectionIntentResultSchema,
  connectionRequestInputSchema,
  connectionsSearchInputSchema,
  createIssueThreadInteractionSchema,
} from "../index.js";

const agentId = "11111111-1111-4111-8111-111111111111";

describe("connection intent contracts", () => {
  it("accepts bounded exact access requests without caller-supplied agent identity", () => {
    expect(connectionRequestInputSchema.parse({ service: "composio", connectionId: agentId, toolNames: ["COMPOSIO_SEARCH_TOOLS"] })).toMatchObject({ connectionId: agentId });
    expect(connectionRequestInputSchema.safeParse({ service: "composio", toolNames: ["read", "read"] }).success).toBe(false);
    expect(connectionRequestInputSchema.safeParse({ service: "composio", toolNames: Array.from({ length: 21 }, (_, i) => `tool-${i}`) }).success).toBe(false);
    expect(connectionRequestInputSchema.safeParse({ service: "composio", agentId }).success).toBe(false);
  });
  it("accepts the versioned server-authored payload and safe phases", () => {
    expect(connectionIntentPayloadSchema.parse({
      version: 1,
      serviceSlug: "notion",
      serviceName: "Notion",
      serviceLogoUrl: "https://example.test/notion.svg",
      requestingAgentId: agentId,
      requestingAgentName: "Researcher",
      phase: "requested",
    })).toMatchObject({ serviceSlug: "notion", phase: "requested" });
  });

  it("rejects credentials, authorization URLs, and unknown phases in thread payloads", () => {
    const base = {
      version: 1,
      serviceSlug: "notion",
      serviceName: "Notion",
      requestingAgentId: agentId,
      requestingAgentName: "Researcher",
      phase: "requested",
    };
    expect(connectionIntentPayloadSchema.safeParse({ ...base, credential: "secret" }).success).toBe(false);
    expect(connectionIntentPayloadSchema.safeParse({ ...base, authorizationUrl: "https://oauth.test" }).success).toBe(false);
    expect(connectionIntentPayloadSchema.safeParse({ ...base, phase: "connected" }).success).toBe(false);
  });

  it("validates terminal outcomes independently from payload state", () => {
    expect(connectionIntentResultSchema.parse({
      version: 1,
      outcome: "connected",
      connectionId: "22222222-2222-4222-8222-222222222222",
    }).outcome).toBe("connected");
    expect(connectionIntentResultSchema.parse({ version: 1, outcome: "declined" }).outcome).toBe("declined");
  });

  it("bounds the server-authored grant and rejects duplicate or unreviewable tools", () => {
    const tool = { catalogEntryId: agentId, toolName: "search", versionHash: "v1", permission: "allowed" };
    const base = { version: 1, serviceSlug: "composio", serviceName: "Composio", requestingAgentId: agentId,
      requestingAgentName: "CEO", phase: "requested" };
    const payload = (tools: unknown[]) => ({ ...base, accessRequest: { connectionId: agentId, connectionName: "Account", tools } });
    expect(connectionIntentPayloadSchema.safeParse(payload([tool])).success).toBe(true);
    expect(connectionIntentPayloadSchema.safeParse(payload([])).success).toBe(false);
    expect(connectionIntentPayloadSchema.safeParse(payload([tool, tool])).success).toBe(false);
    expect(connectionIntentPayloadSchema.safeParse(payload([{ ...tool, versionHash: "" }])).success).toBe(false);
    expect(connectionIntentPayloadSchema.safeParse(payload([{ ...tool, permission: "allow_all" }])).success).toBe(false);
  });

  it("keeps generic interaction creation closed to the server-owned kind", () => {
    expect(createIssueThreadInteractionSchema.safeParse({
      kind: "connection_intent",
      payload: {
        version: 1,
        serviceSlug: "notion",
        serviceName: "Notion",
        requestingAgentId: agentId,
        requestingAgentName: "Researcher",
        phase: "requested",
      },
    }).success).toBe(false);
  });

  it("normalizes canonical search and request tool inputs", () => {
    expect(connectionsSearchInputSchema.parse({ query: "  notion  " })).toEqual({ query: "notion" });
    expect(connectionRequestInputSchema.parse({ service: " notion " })).toEqual({ service: "notion" });
  });
  it("accepts long natural-language searches while bounding input size", () => {
    const query = "Please help me find a connection. ".repeat(30) + "AgentMail inbox";
    expect(connectionsSearchInputSchema.parse({ query }).query).toBe(query);
    expect(connectionsSearchInputSchema.safeParse({ query: "x".repeat(4001) }).success).toBe(false);
  });
});
