import { describe, expect, it } from "vitest";
import { deriveAgentCwd } from "../services/execution-workspaces.js";

describe("deriveAgentCwd", () => {
  it("returns fallback when metadata is null", () => {
    expect(deriveAgentCwd(null, "/local/path")).toBe("/local/path");
  });

  it("returns fallback for local transport", () => {
    const metadata = {
      workspaceRealization: {
        transport: "local",
        remote: { path: "/home/user/workspaces" },
      },
    };
    expect(deriveAgentCwd(metadata, "/local/path")).toBe("/local/path");
  });

  it("returns remote.path for ssh transport with non-empty path", () => {
    const metadata = {
      workspaceRealization: {
        transport: "ssh",
        remote: { path: "/home/oramadan/paperclip-workspaces/cto" },
      },
    };
    expect(deriveAgentCwd(metadata, "/local/mirror/path")).toBe("/home/oramadan/paperclip-workspaces/cto");
  });

  it("returns fallback for ssh transport with empty remote path", () => {
    const metadata = {
      workspaceRealization: {
        transport: "ssh",
        remote: { path: "  " },
      },
    };
    expect(deriveAgentCwd(metadata, "/local/path")).toBe("/local/path");
  });
});
