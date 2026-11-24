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

  it("describes the search label: operator as taking label names, never label IDs", () => {
    const queries = listGoogleWorkspaceRestTools("gmail")
      .map((tool) => (tool.inputSchema.properties as Record<string, { description?: string }> | undefined)?.query?.description)
      .filter((text): text is string => typeof text === "string");
    expect(queries.length).toBeGreaterThanOrEqual(3);
    expect(queries.filter((item) => item.includes("label:"))).toHaveLength(3);
    for (const text of queries.filter((item) => item.includes("label:"))) {
      expect(text).toMatch(/`label:` takes a label name/);
    }
    const everything = JSON.stringify(listGoogleWorkspaceRestTools("gmail"));
    expect(everything).not.toMatch(/label:`? takes label IDs/i);
  });

  it("gives every tool a short human title", () => {
    for (const service of GOOGLE_WORKSPACE_REST_SERVICES) {
      for (const tool of listGoogleWorkspaceRestTools(service)) {
        expect(tool.title, tool.name).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
      }
    }
  });

  it("implements no send tool", () => {
    const names = GOOGLE_WORKSPACE_REST_SERVICES.flatMap((service) => listGoogleWorkspaceRestTools(service).map((tool) => tool.name));
    expect(names.filter((name) => /send/i.test(name))).toEqual([]);
  });

  it("implements every Gmail tool on the allowlist (9 of 9) and nothing else", () => {
    const allowlisted = [
      "get_message", "get_thread", "get_draft", "list_drafts", "list_labels",
      "search_threads", "list_threads", "search_messages", "create_draft",
    ];
    for (const name of allowlisted) expect(googleWorkspaceToolTarget(googleWorkspaceToolName("gmail", name)), name).not.toBeNull();
    for (const name of ["label_message", "label_thread", "unlabel_message", "trash_message", "send_message"]) {
      expect(googleWorkspaceToolTarget(googleWorkspaceToolName("gmail", name)), name).toBeNull();
    }
    expect(listGoogleWorkspaceRestTools("gmail").map((tool) => tool.name).sort()).toEqual([...allowlisted].sort());
  });

  it("implements only read tools besides create_draft", () => {
    const writes = listGoogleWorkspaceRestTools("gmail").filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name);
    expect(writes).toEqual(["create_draft"]);
  });

  it("implements every allowlisted Calendar tool (9 of 9)", () => {
    const allowlisted = ["list_calendars", "get_event", "list_events", "search_events", "suggest_time", "create_event", "update_event", "delete_event", "respond_to_event"];
    for (const name of allowlisted) expect(googleWorkspaceToolTarget(googleWorkspaceToolName("calendar", name)), name).not.toBeNull();
    expect(googleWorkspaceToolTarget(googleWorkspaceToolName("calendar", "unlisted_tool"))).toBeNull();
    expect(listGoogleWorkspaceRestTools("calendar").map((tool) => tool.name).sort()).toEqual([...allowlisted].sort());
  });

  it("implements every allowlisted Drive tool (8 of 8), with only create_file and copy_file writing", () => {
    const allowlisted = ["download_file_content", "get_file_metadata", "get_file_permissions", "list_recent_files", "read_file_content", "search_files", "copy_file", "create_file"];
    for (const name of allowlisted) expect(googleWorkspaceToolTarget(googleWorkspaceToolName("drive", name)), name).not.toBeNull();
    const tools = listGoogleWorkspaceRestTools("drive");
    expect(tools.map((tool) => tool.name).sort()).toEqual([...allowlisted].sort());
    expect(tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name).sort()).toEqual(["copy_file", "create_file"]);
  });

  it("implements no Drive tool that updates, deletes, trashes, moves or shares a file", () => {
    const names = listGoogleWorkspaceRestTools("drive").map((tool) => tool.name);
    expect(names.filter((name) => /update|delete|trash|move|share|permission_|rename|empty/i.test(name))).toEqual([]);
    for (const name of ["update_file", "trash_file", "share_file", "delete_file"]) {
      expect(googleWorkspaceToolTarget(googleWorkspaceToolName("drive", name)), name).toBeNull();
    }
  });

  it.each([
    ["docs", ["read_doc", "update_doc"], ["update_doc"]],
    ["slides", ["read_presentation", "update_presentation"], ["update_presentation"]],
  ] as const)("implements every allowlisted %s tool (2 of 2), writing only through its update tool", (service, allowlisted, writes) => {
    for (const name of allowlisted) expect(googleWorkspaceToolTarget(googleWorkspaceToolName(service, name)), name).not.toBeNull();
    expect(listGoogleWorkspaceRestTools(service).map((tool) => tool.name).sort()).toEqual([...allowlisted].sort());
    expect(listGoogleWorkspaceRestTools(service).filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name)).toEqual(writes);
  });

  it("marks the Docs and Slides update tools destructive and not idempotent, and the reads read-only", () => {
    const annotations = Object.fromEntries((["docs", "slides"] as const).flatMap((service) => listGoogleWorkspaceRestTools(service).map((tool) => [tool.name, tool.annotations])));
    expect(annotations).toEqual({
      read_doc: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      update_doc: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      read_presentation: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      update_presentation: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    });
  });

  it("marks the Calendar tools that overwrite or remove data destructive", () => {
    const annotations = Object.fromEntries(listGoogleWorkspaceRestTools("calendar")
      .filter((tool) => tool.annotations?.readOnlyHint !== true)
      .map((tool) => [tool.name, tool.annotations]));
    expect(annotations).toEqual({
      create_event: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      update_event: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      delete_event: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      respond_to_event: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
  });

  it("adds no create, delete, share or permission tool for Docs or Slides", () => {
    const names = (["docs", "slides"] as const).flatMap((service) => listGoogleWorkspaceRestTools(service).map((tool) => tool.name));
    expect(names.filter((name) => /create|delete|share|permission|copy|trash/i.test(name))).toEqual([]);
  });

  it("implements every allowlisted Sheets tool (6 of 6)", () => {
    const allowlisted = ["get_values", "get_spreadsheet", "update_spreadsheet", "update_values", "update_formulas", "insert_dimension"];
    for (const name of allowlisted) expect(googleWorkspaceToolTarget(googleWorkspaceToolName("sheets", name)), name).not.toBeNull();
    expect(googleWorkspaceToolTarget(googleWorkspaceToolName("sheets", "delete_spreadsheet"))).toBeNull();
    expect(listGoogleWorkspaceRestTools("sheets").map((tool) => tool.name).sort()).toEqual([...allowlisted].sort());
  });
});

