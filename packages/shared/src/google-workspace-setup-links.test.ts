import { describe, expect, it } from "vitest";
import { getConnectableAppDefinition } from "./app-definitions.js";

const MCP_SERVERS_GUIDE = "configure-mcp-servers";
const OAUTH_CLIENT_GUIDE = "https://developers.google.com/workspace/guides/create-credentials#oauth-client-id";

describe("Google Workspace setup links and copy", () => {
  const app = getConnectableAppDefinition("google-workspace")!;
  const method = (key: string) => app.methods.find((candidate) => candidate.key === key)!;

  it("never sends a user to Google's MCP servers guide", () => {
    expect(JSON.stringify(app)).not.toContain(MCP_SERVERS_GUIDE);
  });

  it("gives the Paperclip-managed sign-in no requirements link", () => {
    expect(app.docsUrl).toBeUndefined();
    expect(method("paperclip-workspace").consoleLinks?.docs).toBeUndefined();
  });

  it("links the customer-owned client method to Google's OAuth client guide", () => {
    expect(method("customer-workspace-oauth").consoleLinks?.docs).toBe(OAUTH_CLIENT_GUIDE);
  });

  it("does not mention MCP in user-facing method text", () => {
    for (const entry of app.methods) {
      for (const text of [entry.label, entry.whenToUse, entry.guidanceMd, ...(entry.warnings ?? [])]) {
        expect(text ?? "").not.toMatch(/\bMCP\b/);
      }
    }
  });
});
