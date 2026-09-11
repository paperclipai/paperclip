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
});
