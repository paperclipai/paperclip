import { describe, expect, it } from "vitest";
import { classifySecretOrigin, managedSecretLabel } from "./secret-origin";

const origin = (key: string, name: string) => classifySecretOrigin({ key, name });
const label = (key: string, name: string) => managedSecretLabel({ key, name }, origin(key, name));

describe("classifySecretOrigin", () => {
  it("keeps secrets a person named with the team", () => {
    expect(origin("github-token", "GITHUB_TOKEN")).toBe("team");
    expect(origin("ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY for onboarding")).toBe("team");
    expect(origin("x_write_api_key", "x_write_api_key")).toBe("team");
    expect(origin("airtable-key", "ai-tools/airtable")).toBe("team");
    expect(origin("chatbot-token", "Chatbot token")).toBe("team");
  });

  it("groups credentials saved by connections", () => {
    expect(origin("tool_app.500df1ea-4b23-4c24-93a4-c9802c893448.oauth_access_token", "Neon for the organization OAuth access token 80255b18")).toBe("connections");
    expect(origin("tool_oauth.9ad19afd-323d-47c7-8b95-3d58fda94dcf.oauth_access_token", "GitHub (2) GitHub access token")).toBe("connections");
    expect(origin("slack_manager.b4a7ba86-4b88-41e6-82cf-f5b385752541.access_token", "Slack workspace management access_token aae516bc")).toBe("connections");
  });

  it("groups model sign-ins by generated key or name", () => {
    expect(origin("ai_141d4c34_84d2_4f19_a158_0c64e8985f04", "Riley's OpenAI API key")).toBe("models");
    expect(origin("ai-01d0de1a-ac24-461a-b229-989d2937a4e1", "ai-01d0de1a-ac24-461a-b229-989d2937a4e1")).toBe("models");
  });

  it("groups chat channels, routine webhooks and observability headers", () => {
    expect(origin("chat_slack_5c860bfd_2399_45d8_8ca8_267c05dff5eb_bottoken_565d9081", "chat.slack.5c860bfd.botToken.565d9081")).toBe("chat");
    expect(origin("routine-604ffeed-2bba-4ade-b87d-3db79f481370-99f65874bf29", "routine-604ffeed-2bba-4ade-b87d-3db79f481370-99f65874bf29")).toBe("routines");
    expect(origin("agent_observability_headers_8b0f048a_74cd_49c3_a77d_b004b22921b3", "agent-observability.8b0f048a-74cd-49c3-a77d-b004b22921b3")).toBe("observability");
  });
});

describe("managedSecretLabel", () => {
  it("replaces record IDs with what the secret is for", () => {
    expect(label("chat_slack_x", "chat.slack.5c860bfd.botToken.565d9081")).toBe("Slack bot token");
    expect(label("chat_github_x", "chat.github.bc7e8222.webhookSecret.c1155293")).toBe("GitHub webhook secret");
    expect(label("routine-604ffeed-2bba-4ade-b87d-3db79f481370-99f65874bf29", "routine-604ffeed-2bba-4ade-b87d-3db79f481370-99f65874bf29")).toBe("Routine webhook secret");
    expect(label("ai-01d0de1a-ac24-461a-b229-989d2937a4e1", "ai-01d0de1a-ac24-461a-b229-989d2937a4e1")).toBe("Model provider key");
    expect(label("agent_observability_headers_x", "agent-observability.8b0f048a-74cd-49c3-a77d-b004b22921b3")).toBe("Trace exporter headers");
  });

  it("drops the trailing record suffix from connection names and keeps readable names", () => {
    expect(label("tool_app.500df1ea-4b23-4c24-93a4-c9802c893448.oauth_access_token", "Neon for the organization OAuth access token 80255b18")).toBe("Neon for the organization OAuth access token");
    expect(label("ai_141d4c34_84d2_4f19_a158_0c64e8985f04", "Riley's OpenAI API key")).toBe("Riley's OpenAI API key");
  });
});
