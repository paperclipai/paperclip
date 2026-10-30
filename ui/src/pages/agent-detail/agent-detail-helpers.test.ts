import { describe, expect, it } from "vitest";
import { revisionSummary } from "./AgentHistoryDialog";
import { checkExternalProfile } from "./InstructionsBundleSettings";

describe("revisionSummary", () => {
  it("names the changed parts of the configuration in plain words", () => {
    expect(revisionSummary({ changedKeys: ["adapterConfig"], rolledBackFromRevisionId: null })).toBe("Changed harness settings");
    expect(revisionSummary({ changedKeys: ["name", "title"], rolledBackFromRevisionId: null })).toBe("Changed name and title");
    expect(revisionSummary({ changedKeys: ["name", "runtimeConfig", "budgetMonthlyCents"], rolledBackFromRevisionId: null })).toBe(
      "Changed name, runtime settings and budget",
    );
  });

  it("calls out restores and empty revisions", () => {
    expect(revisionSummary({ changedKeys: ["adapterConfig"], rolledBackFromRevisionId: "rev-1" })).toBe("Restored an earlier version");
    expect(revisionSummary({ changedKeys: [], rolledBackFromRevisionId: null })).toBe("Saved with no tracked changes");
  });
});

describe("checkExternalProfile", () => {
  it("accepts an absolute root and a Markdown entry file", () => {
    expect(checkExternalProfile("/Users/avery/prompts/atlas", "AGENTS.md")).toBeNull();
  });

  it("points at the field that needs fixing", () => {
    expect(checkExternalProfile("prompts/atlas", "AGENTS.md")).toMatchObject({ field: "root" });
    expect(checkExternalProfile("/Users/avery/prompts", "AGENTS.txt")).toMatchObject({ field: "entry" });
    expect(checkExternalProfile("/Users/avery/prompts", "../AGENTS.md")).toMatchObject({ field: "entry" });
  });
});
