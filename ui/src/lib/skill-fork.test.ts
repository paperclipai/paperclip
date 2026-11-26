import { describe, expect, it } from "vitest";
import type {
  CompanySkillForkSummary,
  CompanySkillOriginalSummary,
  CompanySkillUsageAgent,
} from "@paperclipai/shared";
import {
  agentUsageSentence,
  formatForkSourceName,
  formatLineageLabel,
  isProjectScanSkill,
  pickReusableFork,
  reassignTargetIds,
  shortSha,
} from "./skill-fork";

function original(
  over: Partial<CompanySkillOriginalSummary> = {},
): CompanySkillOriginalSummary {
  return {
    id: "orig-1",
    name: "Deep Research",
    slug: "deep-research",
    sourceType: "github",
    sourceLocator: "https://github.com/anthropics/skills",
    sourceRef: "0123456789abcdef0123456789abcdef01234567",
    ...over,
  };
}

function fork(over: Partial<CompanySkillForkSummary> = {}): CompanySkillForkSummary {
  return {
    ...original(),
    id: "fork-1",
    key: "deep-research-fork",
    forkedFromSkillId: "orig-1",
    forkedFromCompanyId: "co-1",
    currentVersionId: "v1",
    createdByCurrentActor: true,
    diverged: false,
    createdAt: new Date("2026-07-09T00:00:00Z"),
    updatedAt: new Date("2026-07-09T00:00:00Z"),
    ...over,
  };
}

describe("shortSha", () => {
  it("shortens a full hex sha to 7 chars", () => {
    expect(shortSha("0123456789abcdef0123456789abcdef01234567")).toBe("0123456");
  });
  it("leaves branch/tag names intact", () => {
    expect(shortSha("main")).toBe("main");
    expect(shortSha("v1.2.0")).toBe("v1.2.0");
  });
  it("returns null for empty/nullish refs", () => {
    expect(shortSha(null)).toBeNull();
    expect(shortSha("")).toBeNull();
    expect(shortSha("   ")).toBeNull();
  });
});

describe("formatForkSourceName", () => {
  it("extracts owner/repo from a github url", () => {
    expect(
      formatForkSourceName({ sourceType: "github", sourceLocator: "https://github.com/anthropics/skills" }),
    ).toBe("anthropics/skills");
  });
  it("extracts owner/repo from github shorthand with subpath and ref", () => {
    expect(
      formatForkSourceName({ sourceType: "github", sourceLocator: "anthropics/skills/some/path#main" }),
    ).toBe("anthropics/skills");
  });
  it("strips .git and ssh scheme", () => {
    expect(
      formatForkSourceName({ sourceType: "github", sourceLocator: "git@github.com:anthropics/skills.git" }),
    ).toBe("anthropics/skills");
  });
  it("cleans a url source", () => {
    expect(
      formatForkSourceName({ sourceType: "url", sourceLocator: "https://example.com/skill/" }),
    ).toBe("example.com/skill");
  });
  it("falls back to a source-type label when no locator", () => {
    expect(formatForkSourceName({ sourceType: "skills_sh", sourceLocator: null })).toBe("skills.sh");
    expect(formatForkSourceName({ sourceType: "catalog", sourceLocator: null })).toBe("the catalog");
  });
});

describe("formatLineageLabel", () => {
  it("includes short sha when a hex ref is pinned", () => {
    expect(formatLineageLabel(original())).toBe("anthropics/skills @ 0123456");
  });
  it("omits the sha clause when no ref is present", () => {
    expect(formatLineageLabel(original({ sourceRef: null }))).toBe("anthropics/skills");
  });
});

describe("pickReusableFork", () => {
  it("returns an un-diverged fork by the current actor", () => {
    const reusable = fork({ id: "reuse-me" });
    expect(pickReusableFork([reusable])?.id).toBe("reuse-me");
  });
  it("ignores diverged forks", () => {
    expect(pickReusableFork([fork({ diverged: true })])).toBeNull();
  });
  it("ignores forks created by other actors", () => {
    expect(pickReusableFork([fork({ createdByCurrentActor: false })])).toBeNull();
  });
  it("returns null with no forks", () => {
    expect(pickReusableFork([])).toBeNull();
  });
});

describe("agentUsageSentence", () => {
  it("handles zero", () => {
    expect(agentUsageSentence(0)).toBe("No agents currently use this skill");
  });
  it("uses singular verb agreement for one agent", () => {
    expect(agentUsageSentence(1)).toBe("1 agent currently uses this skill");
  });
  it("uses plural for many", () => {
    expect(agentUsageSentence(3)).toBe("3 agents currently use this skill");
  });
});

describe("reassignTargetIds", () => {
  it("maps usage agents to their ids", () => {
    const agents: CompanySkillUsageAgent[] = [
      { id: "a1", name: "One", urlKey: "one", adapterType: "claude", desired: true, actualState: null, versionId: null },
      { id: "a2", name: "Two", urlKey: "two", adapterType: "codex", desired: true, actualState: null, versionId: null },
    ];
    expect(reassignTargetIds(agents)).toEqual(["a1", "a2"]);
  });
});

describe("isProjectScanSkill", () => {
  it("detects project_scan metadata", () => {
    expect(isProjectScanSkill({ sourceKind: "project_scan" })).toBe(true);
  });
  it("ignores other source kinds / missing metadata", () => {
    expect(isProjectScanSkill({ sourceKind: "managed_local" })).toBe(false);
    expect(isProjectScanSkill(null)).toBe(false);
    expect(isProjectScanSkill(undefined)).toBe(false);
    expect(isProjectScanSkill({})).toBe(false);
  });
});
