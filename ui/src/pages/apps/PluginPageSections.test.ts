import { describe, expect, it } from "vitest";
import type { ConnectionMethodDef } from "@paperclipai/shared";
import { pluginHost, pluginSignIn } from "./PluginPageSections";

const method = (auth: ConnectionMethodDef["auth"], serverUrl?: string) =>
  ({ key: auth, transport: "mcp_remote", auth, ownershipModes: [], whenToUse: "", defaults: serverUrl ? { serverUrl } : undefined }) as unknown as ConnectionMethodDef;

describe("plugin page facts", () => {
  it("reads the host from the first method that names a valid server", () => {
    expect(pluginHost([method("oauth"), method("api_key", "not a url"), method("api_key", "https://api.example.com/mcp/")])).toBe("api.example.com");
    expect(pluginHost([method("oauth")])).toBeNull();
    expect(pluginHost(undefined)).toBeNull();
  });

  it("lists each sign-in kind once, in definition order", () => {
    expect(pluginSignIn([method("oauth"), method("api_key"), method("oauth")])).toBe("OAuth or API key");
    expect(pluginSignIn([method("none")])).toBe("No sign-in");
    expect(pluginSignIn([])).toBeNull();
  });
});
