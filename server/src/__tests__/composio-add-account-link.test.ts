import { describe, expect, it } from "vitest";
import { composioAddAccountLink, composioAppSetupResult } from "../services/composio-app-setup.js";

describe("Composio add-account link", () => {
  const response = { result: { content: [{ type: "text", text: JSON.stringify({ data: { results: { gmail: {
    toolkit: "gmail", status: "active", accounts: [{ id: "ca_1", status: "active" }], redirect_url: "https://connect.composio.dev/link/next",
  } } }, error: null, successful: true }) }], isError: false } };

  it("returns the new account's link even when the toolkit already has an active account", () => {
    expect(composioAppSetupResult(response, "gmail")).toEqual({ status: "connected" });
    expect(composioAddAccountLink(response)).toBe("https://connect.composio.dev/link/next");
  });

  it("returns no link without a trusted hosted link and rejects provider failures", () => {
    expect(composioAddAccountLink({ results: { gmail: { status: "active" } } })).toBeNull();
    expect(composioAddAccountLink({ results: { gmail: { redirect_url: "https://untrusted.example/link/next" } } })).toBeNull();
    expect(() => composioAddAccountLink({ isError: true })).toThrow("could not configure");
  });
});
