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

  it("mentions only tools this package lists in any description", () => {
    for (const service of GOOGLE_WORKSPACE_REST_SERVICES) {
      const tools = listGoogleWorkspaceRestTools(service);
      const names = new Set(tools.map((tool) => tool.name));
      const descriptions: string[] = [];
      const collect = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === "object") {
          for (const [key, item] of Object.entries(value)) {
            if (key === "description" && typeof item === "string") descriptions.push(item);
            else collect(item);
          }
        }
      };
      tools.forEach(collect);
      const mentioned = descriptions.flatMap((text) => text.match(/\b[a-z]+(?:_[a-z]+)+\b(?!:)/g) ?? []);
      expect(mentioned.filter((name) => !names.has(name))).toEqual([]);
    }
  });

  it("implements no send tool", () => {
    const names = GOOGLE_WORKSPACE_REST_SERVICES.flatMap((service) => listGoogleWorkspaceRestTools(service).map((tool) => tool.name));
    expect(names.filter((name) => /send/i.test(name))).toEqual([]);
  });

  it("implements every allowlisted Calendar tool (9 of 9)", () => {
    const allowlisted = ["list_calendars", "get_event", "list_events", "search_events", "suggest_time", "create_event", "update_event", "delete_event", "respond_to_event"];
    for (const name of allowlisted) expect(googleWorkspaceToolTarget(googleWorkspaceToolName("calendar", name)), name).not.toBeNull();
    expect(googleWorkspaceToolTarget(googleWorkspaceToolName("calendar", "unlisted_tool"))).toBeNull();
    expect(listGoogleWorkspaceRestTools("calendar").map((tool) => tool.name).sort()).toEqual([...allowlisted].sort());
  });

  it("implements the Gmail tools of this release", () => {
    expect(listGoogleWorkspaceRestTools("gmail").map((tool) => tool.name)).toEqual(["get_message", "search_threads", "create_draft"]);
  });
});
