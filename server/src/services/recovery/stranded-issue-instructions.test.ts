import { describe, expect, it } from "vitest";
import {
  STRANDED_ISSUE_RECOVERY_REQUIRED_ACTION,
  SUCCESSFUL_RUN_MISSING_STATE_REQUIRED_ACTION,
} from "./stranded-issue-instructions.js";

const allInstructions = [
  { name: "stranded issue", lines: STRANDED_ISSUE_RECOVERY_REQUIRED_ACTION },
  { name: "successful run missing state", lines: SUCCESSFUL_RUN_MISSING_STATE_REQUIRED_ACTION },
];

describe("recovery owner instructions", () => {
  for (const { name, lines } of allInstructions) {
    describe(name, () => {
      const text = lines.join("\n");

      it("forbids the recovery owner from doing the source issue's own work", () => {
        expect(text).toMatch(/never (do|perform|complete) the source issue's work/i);
      });

      it("forbids trusting an agent's self-reported completion", () => {
        expect(text).toMatch(/self-report/i);
      });

      it("tells the owner to verify the claimed artifact at its required location", () => {
        expect(text).toMatch(/verify/i);
        expect(text).toMatch(/artifact/i);
      });
    });
  }

  it("forbids the stranded-issue recovery owner from marking the source issue done", () => {
    const text = STRANDED_ISSUE_RECOVERY_REQUIRED_ACTION.join("\n");
    expect(text).toMatch(/never (mark|set) the source issue .*`?done`?/i);
  });

  it("still lets the owner close the recovery issue itself", () => {
    for (const { lines } of allInstructions) {
      expect(lines.join("\n")).toMatch(/mark this recovery issue done/i);
    }
  });
});
