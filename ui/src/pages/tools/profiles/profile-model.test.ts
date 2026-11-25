// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ToolCatalogEntry, ToolProfileEntry } from "@paperclipai/shared";
import {
  appCheckState,
  appSelectionLabel,
  buildEntries,
  countAllowedTools,
  groupCatalogByApp,
  parseEntries,
  templateSelections,
  toggleApp,
  toggleTool,
  type AppGroup,
} from "./profile-model";

function tool(partial: Partial<ToolCatalogEntry> & { id: string; toolName: string }): ToolCatalogEntry {
  return {
    companyId: "c1",
    applicationId: "app-gmail",
    connectionId: "conn-1",
    entryKind: "tool",
    title: null,
    description: null,
    inputSchema: null,
    outputSchema: null,
    annotations: null,
    riskLevel: "read",
    isReadOnly: true,
    isWrite: false,
    isDestructive: false,
    status: "active",
    addedAt: new Date(),
    version: null,
    schemaHash: null,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    reviewedAt: null,
    reviewedByAgentId: null,
    reviewedByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as ToolCatalogEntry;
}

function entry(partial: Partial<ToolProfileEntry> & Pick<ToolProfileEntry, "selectorType">): ToolProfileEntry {
  return {
    id: `e-${partial.selectorType}-${partial.catalogEntryId ?? partial.applicationId ?? partial.toolName ?? "x"}`,
    companyId: "c1",
    profileId: "p1",
    effect: "include",
    applicationId: null,
    connectionId: null,
    catalogEntryId: null,
    toolName: null,
    riskLevel: null,
    conditions: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as ToolProfileEntry;
}

const appsById = new Map([
  ["app-gmail", "Gmail"],
  ["app-slack", "Slack"],
]);
const connsById = new Map([["conn-1", "Gmail prod"]]);

// 4 Gmail tools: 2 read, 1 write, 1 destructive.
const catalog: ToolCatalogEntry[] = [
  tool({ id: "g-list", toolName: "gmail.list", riskLevel: "read", isReadOnly: true }),
  tool({ id: "g-read", toolName: "gmail.read", riskLevel: "read", isReadOnly: true }),
  tool({ id: "g-send", toolName: "gmail.send", riskLevel: "write", isReadOnly: false, isWrite: true }),
  tool({ id: "g-delete", toolName: "gmail.delete", riskLevel: "destructive", isReadOnly: false, isWrite: true, isDestructive: true }),
];

function gmail(): AppGroup {
  return groupCatalogByApp(catalog, appsById, connsById)[0];
}

describe("groupCatalogByApp", () => {
  it("groups by application and names from the app map", () => {
    const groups = groupCatalogByApp(catalog, appsById, connsById);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Gmail");
    expect(groups[0].tools.map((t) => t.id)).toEqual(["g-delete", "g-list", "g-read", "g-send"]);
  });
});

describe("toggleApp / toggleTool", () => {
  it("app checkbox flips between all and none", () => {
    const g = gmail();
    let sel = toggleApp(g, undefined);
    expect(sel).toEqual({ kind: "all" });
    expect(appCheckState(g, sel)).toBe("checked");
    sel = toggleApp(g, sel);
    expect(sel).toEqual({ kind: "none" });
  });

  it("unchecking one tool from all yields all_except with except-count math", () => {
    const g = gmail();
    let sel = toggleApp(g, undefined); // all
    sel = toggleTool(g, sel, "g-delete");
    expect(sel).toEqual({ kind: "all_except", excluded: ["g-delete"] });
    expect(appSelectionLabel(g, sel)).toBe("All Gmail except 1");
    expect(appCheckState(g, sel)).toBe("indeterminate");
    // re-check it -> back to all
    sel = toggleTool(g, sel, "g-delete");
    expect(sel).toEqual({ kind: "all" });
  });

  it("checking tools from empty yields explicit some-selection", () => {
    const g = gmail();
    let sel = toggleTool(g, undefined, "g-list");
    sel = toggleTool(g, sel, "g-read");
    expect(sel).toEqual({ kind: "some", included: ["g-list", "g-read"] });
    expect(appSelectionLabel(g, sel)).toBe("2 of 4 Gmail tools");
  });

  it("keeps an explicit selection when every current tool is checked", () => {
    const g = gmail();
    let sel: ReturnType<typeof toggleTool> | undefined;
    for (const id of ["g-list", "g-read", "g-send", "g-delete"]) sel = toggleTool(g, sel, id);
    expect(sel).toEqual({ kind: "some", included: ["g-delete", "g-list", "g-read", "g-send"] });
  });

  it("excluding every tool collapses to none", () => {
    const g = gmail();
    let sel: ReturnType<typeof toggleApp> = { kind: "all" };
    for (const id of ["g-list", "g-read", "g-send", "g-delete"]) sel = toggleTool(g, sel, id);
    expect(sel).toEqual({ kind: "none" });
  });
});

describe("buildEntries", () => {
  it("maps all -> application include", () => {
    const g = gmail();
    expect(buildEntries([g], { [g.appKey]: { kind: "all" } })).toEqual([
      { selectorType: "application", effect: "include", applicationId: "app-gmail" },
    ]);
  });

  it("maps all_except -> app include plus catalog excludes", () => {
    const g = gmail();
    expect(buildEntries([g], { [g.appKey]: { kind: "all_except", excluded: ["g-delete"] } })).toEqual([
      { selectorType: "application", effect: "include", applicationId: "app-gmail" },
      { selectorType: "catalog_entry", effect: "exclude", catalogEntryId: "g-delete" },
    ]);
  });

  it("maps some -> per-tool catalog includes", () => {
    const g = gmail();
    expect(buildEntries([g], { [g.appKey]: { kind: "some", included: ["g-list"] } })).toEqual([
      { selectorType: "catalog_entry", effect: "include", catalogEntryId: "g-list" },
    ]);
  });

  it("maps bounded allow-default selections to catalog excludes", () => {
    const g = gmail();
    expect(
      buildEntries([g], { [g.appKey]: { kind: "some", included: ["g-list"] } }, [], "allow"),
    ).toEqual([
      { selectorType: "catalog_entry", effect: "exclude", catalogEntryId: "g-delete" },
      { selectorType: "catalog_entry", effect: "exclude", catalogEntryId: "g-read" },
      { selectorType: "catalog_entry", effect: "exclude", catalogEntryId: "g-send" },
    ]);
  });

  it("maps none under allow-default to exclusions for every catalog tool", () => {
    const g = gmail();
    expect(buildEntries([g], { [g.appKey]: { kind: "none" } }, [], "allow")).toEqual(
      g.tools.map((tool) => ({
        selectorType: "catalog_entry",
        effect: "exclude",
        catalogEntryId: tool.id,
      })),
    );
  });

  it("appends advanced rules", () => {
    const g = gmail();
    const out = buildEntries([g], { [g.appKey]: { kind: "none" } }, [
      { id: "r1", kind: "tool_name", value: "gmail.*", effect: "exclude" },
    ]);
    expect(out).toEqual([{ selectorType: "tool_name", effect: "exclude", toolName: "gmail.*" }]);
  });
});

describe("parseEntries round-trips buildEntries", () => {
  it("round-trips all_except", () => {
    const g = gmail();
    const sel = { [g.appKey]: { kind: "all_except" as const, excluded: ["g-delete"] } };
    const entries = buildEntries([g], sel).map((e, i) => entry({ ...e, id: `e${i}` } as never));
    const parsed = parseEntries([g], entries);
    expect(parsed.selections[g.appKey]).toEqual({ kind: "all_except", excluded: ["g-delete"] });
    expect(parsed.advancedRules).toEqual([]);
  });

  it("round-trips some", () => {
    const g = gmail();
    const entries = buildEntries([g], { [g.appKey]: { kind: "some", included: ["g-list", "g-read"] } }).map(
      (e, i) => entry({ ...e, id: `e${i}` } as never),
    );
    const parsed = parseEntries([g], entries);
    expect(parsed.selections[g.appKey]).toEqual({ kind: "some", included: ["g-list", "g-read"] });
  });

  it("keeps all explicit catalog entries as a bounded selection", () => {
    const g = gmail();
    const entries = g.tools.map((tool, index) => entry({
      id: `e${index}`,
      selectorType: "catalog_entry",
      catalogEntryId: tool.id,
      effect: "include",
    }));

    const parsed = parseEntries([g], entries);

    expect(parsed.selections[g.appKey]).toEqual({
      kind: "some",
      included: ["g-delete", "g-list", "g-read", "g-send"],
    });
  });

  it("surfaces a wildcard rule as an advanced rule", () => {
    const g = gmail();
    const parsed = parseEntries([g], [entry({ selectorType: "tool_name", toolName: "gmail.*", effect: "exclude" })]);
    expect(parsed.advancedRules).toEqual([
      { id: "e-tool_name-gmail.*", kind: "tool_name", value: "gmail.*", effect: "exclude" },
    ]);
  });
});

describe("countAllowedTools", () => {
  it("counts selected tools in deny mode", () => {
    const g = gmail();
    expect(countAllowedTools([g], { [g.appKey]: { kind: "all_except", excluded: ["g-delete"] } }, "deny", 4)).toEqual({
      allowed: 3,
      total: 4,
    });
  });

  it("counts everything minus opt-outs in allow mode", () => {
    const g = gmail();
    expect(countAllowedTools([g], { [g.appKey]: { kind: "all_except", excluded: ["g-delete", "g-send"] } }, "allow", 4)).toEqual({
      allowed: 2,
      total: 4,
    });
  });
});

describe("templateSelections", () => {
  it("read-only selects only read tools", () => {
    const g = gmail();
    const sel = templateSelections("read_only", [g]);
    expect(sel[g.appKey]).toEqual({ kind: "some", included: ["g-list", "g-read"] });
  });

  it("everyday excludes destructive", () => {
    const g = gmail();
    const sel = templateSelections("everyday", [g]);
    expect(sel[g.appKey]).toEqual({ kind: "some", included: ["g-list", "g-read", "g-send"] });
  });

  it("full access selects all", () => {
    const g = gmail();
    expect(templateSelections("full_access", [g])[g.appKey]).toEqual({ kind: "all" });
  });

  it("scratch selects none", () => {
    const g = gmail();
    expect(templateSelections("scratch", [g])[g.appKey]).toEqual({ kind: "none" });
  });
});
