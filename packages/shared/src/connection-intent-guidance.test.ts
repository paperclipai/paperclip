import { describe, expect, it } from "vitest";
import { CONNECTION_INTENT_AGENT_GUIDANCE, CONNECTION_REQUEST_TOOL_DESCRIPTION, CONNECTION_RUNTIME_TOOL_NAMES, CONNECTIONS_SEARCH_TOOL_DESCRIPTION } from "./connection-intent-guidance.js";
describe("connection result guidance", () => {
  it("delegates route decisions to trusted tool output instead of a provider decision tree", () => {
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain("follow the returned `instruction`");
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain("Respect recorded user choices");
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).not.toMatch(/Composio|Arcade|Executor|Zapier/);
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).not.toMatch(/https?:\/\/|bearer/);
  });
  it("retains waiting, credential, and arbitrary URL boundaries", () => {
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain("yield without retrying or polling");
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain("never invent access or ask for credentials in comments");
    expect(CONNECTION_INTENT_AGENT_GUIDANCE).toContain("arbitrary MCP URLs");
  });
  it("describes exact questions and saved selection proof", () => {
    expect(CONNECTIONS_SEARCH_TOOL_DESCRIPTION).toContain("exact providerQuestion");
    expect(CONNECTION_REQUEST_TOOL_DESCRIPTION).toContain("saved provider-selection interaction ID");
    expect(CONNECTION_RUNTIME_TOOL_NAMES).toEqual(["connections_search","connection_request"]);
  });
});
