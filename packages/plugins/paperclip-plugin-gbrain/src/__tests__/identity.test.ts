import { describe, it, expect } from "vitest";
import { issueSlug, agentSlug, projectSlug, factSlug, PAGE_TYPES } from "../identity.js";

describe("issueSlug", () => {
  it("formats identifier as issue-<lowercased-identifier>", () => {
    expect(issueSlug("BLO-3220")).toBe("issue-blo-3220");
    expect(issueSlug("PCL-1490")).toBe("issue-pcl-1490");
  });

  it("returns null when identifier is missing", () => {
    expect(issueSlug(null)).toBeNull();
    expect(issueSlug(undefined)).toBeNull();
    expect(issueSlug("")).toBeNull();
  });

  it("trims surrounding whitespace and normalizes", () => {
    expect(issueSlug("  BLO-3220 ")).toBe("issue-blo-3220");
  });
});

describe("agentSlug", () => {
  it("lowercases and joins with hyphens", () => {
    expect(agentSlug("CTO")).toBe("agent-cto");
    expect(agentSlug("MulticastEngineer")).toBe("agent-multicastengineer");
    expect(agentSlug("Release Engineer")).toBe("agent-release-engineer");
  });

  it("collapses runs of separators", () => {
    expect(agentSlug("QA   Engineer")).toBe("agent-qa-engineer");
    expect(agentSlug("Foo-Bar_Baz.Qux")).toBe("agent-foo-bar-baz-qux");
  });

  it("returns null when name is empty after normalization", () => {
    expect(agentSlug("   ")).toBeNull();
    expect(agentSlug("")).toBeNull();
    expect(agentSlug(null)).toBeNull();
  });
});

describe("projectSlug", () => {
  it("lowercases and joins with hyphens", () => {
    expect(projectSlug("RAG Fixes")).toBe("project-rag-fixes");
    expect(projectSlug("gbrain_recall")).toBe("project-gbrain-recall");
  });

  it("returns null when name is empty after normalization", () => {
    expect(projectSlug("   ")).toBeNull();
    expect(projectSlug("")).toBeNull();
    expect(projectSlug(null)).toBeNull();
  });
});

describe("factSlug", () => {
  it("formats uuid as fact-<uuid>", () => {
    expect(factSlug("11111111-2222-3333-4444-555555555555")).toBe(
      "fact-11111111-2222-3333-4444-555555555555",
    );
  });
});

describe("PAGE_TYPES", () => {
  it("exports stable type constants", () => {
    expect(PAGE_TYPES.ISSUE).toBe("issue");
    expect(PAGE_TYPES.AGENT).toBe("agent");
    expect(PAGE_TYPES.PROJECT).toBe("project");
    expect(PAGE_TYPES.FACT).toBe("fact");
  });
});
