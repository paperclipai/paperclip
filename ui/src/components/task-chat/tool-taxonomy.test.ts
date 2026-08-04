import { describe, expect, it } from "vitest";
import {
  BookOpen,
  Brain,
  ChevronsLeftRightEllipsis,
  MessageSquareReply,
  Network,
  Search,
  SearchCode,
  Terminal,
  Wrench,
} from "lucide-react";
import { McpIcon } from "./McpIcon";
import { isGenericToolName, mcpToolSegment, statusLabelIcon, toolTaxonomy } from "./tool-taxonomy";

describe("toolTaxonomy", () => {
  it("maps each family to its icon and verb", () => {
    expect(toolTaxonomy("Bash")).toEqual({
      family: "terminal",
      icon: Terminal,
      verbLabel: "Running a command",
    });
    expect(toolTaxonomy("Shell").family).toBe("terminal");

    expect(toolTaxonomy("Grep")).toEqual({
      family: "grep",
      icon: SearchCode,
      verbLabel: "Grepping",
    });

    expect(toolTaxonomy("Glob")).toEqual({
      family: "search",
      icon: Search,
      verbLabel: "Searching",
    });
    expect(toolTaxonomy("WebSearch").family).toBe("search");

    expect(toolTaxonomy("Read")).toEqual({
      family: "read",
      icon: BookOpen,
      verbLabel: "Reading files",
    });
    expect(toolTaxonomy("NotebookRead").family).toBe("read");

    // Round-4 board feedback: edits share the terminal glyph.
    expect(toolTaxonomy("Edit")).toEqual({
      family: "edit",
      icon: Terminal,
      verbLabel: "Editing files",
    });
    expect(toolTaxonomy("Write").family).toBe("edit");
    expect(toolTaxonomy("MultiEdit").family).toBe("edit");
    expect(toolTaxonomy("NotebookEdit").family).toBe("edit");

    expect(toolTaxonomy("WebFetch")).toEqual({
      family: "web",
      icon: ChevronsLeftRightEllipsis,
      verbLabel: "Fetching the web",
    });

    expect(toolTaxonomy("Task")).toEqual({
      family: "agent",
      icon: Network,
      verbLabel: "Delegating",
    });
    expect(toolTaxonomy("Agent").family).toBe("agent");
  });

  it("collapses mcp__ names to the MCP logo with the tool segment verb", () => {
    const entry = toolTaxonomy("mcp__linear-server__search_issues");
    expect(entry.family).toBe("mcp");
    expect(entry.icon).toBe(McpIcon);
    expect(entry.verbLabel).toBe("Using Search_issues");
  });

  it("falls back to the Wrench for unknown or empty names", () => {
    expect(toolTaxonomy("SomethingNovel")).toEqual({
      family: "other",
      icon: Wrench,
      verbLabel: "Working",
    });
    expect(toolTaxonomy("")).toEqual({ family: "other", icon: Wrench, verbLabel: "Working" });
    expect(toolTaxonomy(undefined).icon).toBe(Wrench);
    expect(toolTaxonomy(null).icon).toBe(Wrench);
  });
});

describe("toolTaxonomy multi-word ACP titles", () => {
  it("classifies by the first word", () => {
    expect(toolTaxonomy("Read File").icon).toBe(BookOpen);
    expect(toolTaxonomy("Edit File").icon).toBe(Terminal);
    expect(toolTaxonomy("Write File").icon).toBe(Terminal);
    expect(toolTaxonomy("Terminal").icon).toBe(Terminal);
  });
});

describe("statusLabelIcon", () => {
  it("gives the tool-free informative statuses their glyphs", () => {
    expect(statusLabelIcon("Thinking")).toBe(Brain);
    expect(statusLabelIcon("Responding")).toBe(MessageSquareReply);
    expect(statusLabelIcon("Responding (streaming)")).toBe(MessageSquareReply);
  });

  it("leaves whimsified and generic labels glyph-free", () => {
    for (const label of ["Running", "Working", "Clipping", "Brewing", "Queued", "", undefined, null]) {
      expect(statusLabelIcon(label)).toBeNull();
    }
  });
});

describe("isGenericToolName", () => {
  it("flags acpx placeholder names, including status-suffixed variants", () => {
    expect(isGenericToolName("tool call")).toBe(true);
    expect(isGenericToolName("tool call (completed)")).toBe(true);
    expect(isGenericToolName("Tool Call (failed)")).toBe(true);
    expect(isGenericToolName("acp_tool")).toBe(true);
    expect(isGenericToolName("tool")).toBe(true);
    expect(isGenericToolName("")).toBe(true);
    expect(isGenericToolName(undefined)).toBe(true);
  });

  it("keeps real names", () => {
    expect(isGenericToolName("Terminal")).toBe(false);
    expect(isGenericToolName("Read")).toBe(false);
    expect(isGenericToolName("mcp__linear__search_issues")).toBe(false);
  });
});

describe("mcpToolSegment", () => {
  it("extracts and capitalizes the tool segment", () => {
    expect(mcpToolSegment("mcp__linear-server__search_issues")).toBe("Search_issues");
    expect(mcpToolSegment("mcp__gh__create_pr")).toBe("Create_pr");
  });

  it("returns null for non-mcp names", () => {
    expect(mcpToolSegment("Bash")).toBeNull();
    expect(mcpToolSegment("mcpish")).toBeNull();
  });
});
