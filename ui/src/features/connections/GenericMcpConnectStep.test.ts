import { describe, expect, it } from "vitest";
import { newCustomHeaderRow, type CustomHeaderRow } from "@/pages/apps/generic-mcp-connect";
import { genericMcpAuthSummary } from "./GenericMcpConnectStep";

function header(name: string, value: string): CustomHeaderRow {
  return { ...newCustomHeaderRow(), name, value };
}

describe("genericMcpAuthSummary", () => {
  const base = { headers: [newCustomHeaderRow()], oauthClientId: "" };

  it("states each sign-in choice in plain words", () => {
    expect(genericMcpAuthSummary({ ...base, authMode: "auto" })).toBe("Paperclip asks the server how to sign in.");
    expect(genericMcpAuthSummary({ ...base, authMode: "none" })).toBe(
      "No sign-in. The server is open to anyone with the address.",
    );
    expect(genericMcpAuthSummary({ ...base, authMode: "bearer" })).toBe("Signs in with a key or token.");
    expect(genericMcpAuthSummary({ ...base, authMode: "oauth" })).toBe("You’ll sign in at the provider.");
  });

  it("counts only complete custom headers", () => {
    expect(genericMcpAuthSummary({ ...base, authMode: "custom_headers" })).toBe("Signs in with custom headers.");
    expect(
      genericMcpAuthSummary({
        ...base,
        authMode: "custom_headers",
        headers: [header("X-Api-Key", "a"), header("X-Workspace", " ")],
      }),
    ).toBe("Signs in with 1 custom header.");
    expect(
      genericMcpAuthSummary({
        ...base,
        authMode: "custom_headers",
        headers: [header("X-Api-Key", "a"), header("X-Workspace", "b")],
      }),
    ).toBe("Signs in with 2 custom headers.");
  });

  it("mentions an operator-supplied client ID", () => {
    expect(genericMcpAuthSummary({ ...base, authMode: "oauth", oauthClientId: " client " })).toBe(
      "You’ll sign in at the provider, using your own client ID.",
    );
  });
});
