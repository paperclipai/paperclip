// The reviewed allowlist (`toolScopes` in @paperclipai/shared) stays the single
// list of allowed Google tools. This package may implement only tools on it.
// Test-only import: the package itself knows nothing about Paperclip.
import { googleWorkspaceToolName, googleWorkspaceToolTarget } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { GOOGLE_WORKSPACE_REST_SERVICES, listGoogleWorkspaceRestTools } from "./tools.js";

describe("tool allowlist", () => {
  for (const service of GOOGLE_WORKSPACE_REST_SERVICES) {
    for (const tool of listGoogleWorkspaceRestTools(service)) {
      it(`${service} ${tool.name} is on the reviewed allowlist, with matching read/write intent`, () => {
        const target = googleWorkspaceToolTarget(googleWorkspaceToolName(service, tool.name));
        expect(target, `${tool.name} is not in toolScopes.${service}`).not.toBeNull();
        expect(target!.leaf).toBe(tool.name);
        expect(tool.annotations?.readOnlyHint).toBe(!target!.write);
      });
    }
  }

  it("implements no send tool", () => {
    const names = GOOGLE_WORKSPACE_REST_SERVICES.flatMap((service) => listGoogleWorkspaceRestTools(service).map((tool) => tool.name));
    expect(names.filter((name) => /send/i.test(name))).toEqual([]);
  });

  it("implements the Gmail tools of this release", () => {
    expect(listGoogleWorkspaceRestTools("gmail").map((tool) => tool.name)).toEqual(["get_message", "search_threads", "create_draft"]);
  });
});
