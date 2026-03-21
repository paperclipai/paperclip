import { describe, it, expect } from "vitest";
import { resolveClaimedApiKeyPath } from "@paperclipai/adapter-openclaw-gateway/server";

describe("resolveClaimedApiKeyPath", () => {
  it("returns default path when no config is set", () => {
    expect(resolveClaimedApiKeyPath({})).toBe(
      "~/.openclaw/workspace/paperclip-claimed-api-key.json",
    );
  });

  it("returns explicit claimedApiKeyPath when set", () => {
    const path = "/custom/path/to/key.json";
    expect(resolveClaimedApiKeyPath({ claimedApiKeyPath: path })).toBe(path);
  });

  it("derives path from openclawWorkspace", () => {
    expect(
      resolveClaimedApiKeyPath({ openclawWorkspace: "~/.openclaw/workspace-nora" }),
    ).toBe("~/.openclaw/workspace-nora/paperclip-claimed-api-key.json");
  });

  it("strips trailing slash from openclawWorkspace", () => {
    expect(
      resolveClaimedApiKeyPath({ openclawWorkspace: "~/.openclaw/workspace-nora/" }),
    ).toBe("~/.openclaw/workspace-nora/paperclip-claimed-api-key.json");
  });

  it("prefers claimedApiKeyPath over openclawWorkspace", () => {
    expect(
      resolveClaimedApiKeyPath({
        claimedApiKeyPath: "/explicit/key.json",
        openclawWorkspace: "~/.openclaw/workspace-nora",
      }),
    ).toBe("/explicit/key.json");
  });

  it("ignores empty string config values", () => {
    expect(
      resolveClaimedApiKeyPath({ claimedApiKeyPath: "", openclawWorkspace: "" }),
    ).toBe("~/.openclaw/workspace/paperclip-claimed-api-key.json");
  });
});
