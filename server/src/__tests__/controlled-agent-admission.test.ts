import { describe, expect, it } from "vitest";
import { validateControlledAgentAdmission } from "../services/controlled-agent-admission.js";

const now = new Date("2026-08-11T11:00:00.000Z");
const manualAgent = { adapterType: "claude_local", runtimeConfig: { manualOnlyAdmission: true } };

describe("validateControlledAgentAdmission", () => {
  it("preserves ordinary and deterministic resume behavior", () => {
    expect(validateControlledAgentAdmission({ adapterType: "claude_local", runtimeConfig: {} }, {}, now)).toEqual({
      ok: true,
      admission: null,
    });
    expect(validateControlledAgentAdmission({ adapterType: "paperclip_shell_handler", runtimeConfig: { manualOnlyAdmission: true } }, {}, now)).toEqual({
      ok: true,
      admission: null,
    });
  });

  it("rejects an unscoped stale controller resume", () => {
    expect(validateControlledAgentAdmission(manualAgent, {}, now)).toMatchObject({
      ok: false,
      code: "CONTROLLED_ADMISSION_REQUIRED",
    });
  });

  it("accepts and normalizes an issue-bound resume", () => {
    expect(validateControlledAgentAdmission(manualAgent, {
      controlledAdmission: { mode: "issue", reason: "bounded revenue run", taskKey: "TSR-5382" },
    }, now)).toEqual({
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
    }, now)).toMatchObject({ ok: false, code: "CONTROLLED_ADMISSION_REQUIRED" });
  });

  it("accepts only a short-lived supervision window", () => {
    expect(validateControlledAgentAdmission(manualAgent, {
      controlledAdmission: {
        mode: "supervision",
        reason: "observe one bounded production cell",
        expiresAt: "2026-08-11T12:30:00Z",
      },
    }, now)).toMatchObject({ ok: true });
    expect(validateControlledAgentAdmission(manualAgent, {
      controlledAdmission: {
        mode: "supervision",
        reason: "too broad",
        expiresAt: "2026-08-11T14:00:01Z",
      },
    }, now)).toMatchObject({ ok: false, code: "CONTROLLED_ADMISSION_REQUIRED" });
  });
});
