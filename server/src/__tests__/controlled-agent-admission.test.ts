import { describe, expect, it } from "vitest";
import { validateControlledAgentAdmission } from "../services/controlled-agent-admission.js";

const manualAgent = { adapterType: "claude_local", runtimeConfig: { manualOnlyAdmission: true } };

describe("validateControlledAgentAdmission", () => {
  it("preserves ordinary and deterministic resume behavior", () => {
    expect(validateControlledAgentAdmission({ adapterType: "claude_local", runtimeConfig: {} }, {})).toEqual({
      ok: true,
      admission: null,
    });
    expect(validateControlledAgentAdmission({ adapterType: "paperclip_shell_handler", runtimeConfig: { manualOnlyAdmission: true } }, {})).toEqual({
      ok: true,
      admission: null,
    });
  });

  it("rejects an unscoped stale controller resume", () => {
    expect(validateControlledAgentAdmission(manualAgent, {})).toMatchObject({
      ok: false,
      code: "CONTROLLED_ADMISSION_REQUIRED",
    });
  });

  it("accepts and normalizes an issue-bound resume", () => {
    expect(validateControlledAgentAdmission(manualAgent, {
      controlledAdmission: { mode: "issue", reason: "bounded revenue run", taskKey: "TSR-5382" },
    })).toEqual({
      ok: true,
      admission: {
        mode: "issue",
        reason: "bounded revenue run",
        issueId: undefined,
        taskId: undefined,
        taskKey: "TSR-5382",
      },
    });
  });

  it("rejects issue mode without an issue binding", () => {
    expect(validateControlledAgentAdmission(manualAgent, {
      controlledAdmission: { mode: "issue", reason: "missing scope" },
    })).toMatchObject({ ok: false, code: "CONTROLLED_ADMISSION_REQUIRED" });
  });

  it("rejects generic supervision admission", () => {
    expect(validateControlledAgentAdmission(manualAgent, {
      controlledAdmission: {
        mode: "supervision",
        reason: "observe a production cell",
      },
    })).toMatchObject({ ok: false, code: "CONTROLLED_ADMISSION_REQUIRED" });
  });
});
