import { describe, expect, it } from "vitest";
import { extractNextOwnerHandoffReferences } from "../services/next-owner-handoff.js";

describe("next owner handoff parsing", () => {
  it("extracts candidate references from prose Next owner lines", () => {
    expect(
      extractNextOwnerHandoffReferences(
        [
          "Status: code fix applied.",
          "Next owner: Chrysler_Codex (or CEO/Chrysler)",
          "Next action: choose the canonical doc ID.",
        ].join("\n"),
      ),
    ).toEqual([
      {
        line: "Next owner: Chrysler_Codex (or CEO/Chrysler)",
        explicitAgentIds: [],
        references: ["Chrysler_Codex", "CEO", "Chrysler"],
      },
    ]);
  });

  it("prefers explicit agent links over prose references", () => {
    const agentId = "55555555-5555-4555-8555-555555555555";
    expect(
      extractNextOwnerHandoffReferences(`**Next Owner:** [CEO](agent://${agentId}) — decide and rerun.`),
    ).toEqual([
      {
        line: `**Next Owner:** [CEO](agent://${agentId}) — decide and rerun.`,
        explicitAgentIds: [agentId],
        references: [],
      },
    ]);
  });

  it("extracts an embedded Next owner clause from harness summary prose", () => {
    const line = "Canonical stage: platform recovery. Current owner: Founding Engineer. Next owner: CTO/Paperclip platform owner. Return owner: CTO technical sign-off.";
    expect(extractNextOwnerHandoffReferences(line)).toEqual([
      {
        line,
        explicitAgentIds: [],
        references: ["CTO", "Paperclip platform owner"],
      },
    ]);
  });

  it("ignores next action lines without a next owner contract", () => {
    expect(extractNextOwnerHandoffReferences("Next action: CEO should decide.")).toEqual([]);
  });
});
