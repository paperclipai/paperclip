import { describe, expect, it } from "vitest";
import { resolvePaperclipDesiredSkillNames } from "./server-utils.js";

const MANAGER_ONLY_KEYS = [
  "paperclipai/paperclip/paperclip-create-agent",
  "paperclipai/paperclip/paperclip-create-plugin",
  "paperclipai/paperclip/para-memory-files",
  "paperclipai/paperclip/plan-ceo-review",
  "paperclipai/paperclip/office-hours",
  "paperclipai/paperclip/autoplan",
];

function buildEntries() {
  const managerEntries = MANAGER_ONLY_KEYS.map((key) => ({
    key,
    runtimeName: key.split("/").pop()!,
    required: true,
    managerOnly: true,
  }));
  const icEntries = [
    { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", required: true, managerOnly: false },
    { key: "paperclipai/paperclip/caveman", runtimeName: "caveman", required: true, managerOnly: false },
    { key: "paperclipai/paperclip/code-review", runtimeName: "code-review", required: true, managerOnly: false },
  ];
  return [...managerEntries, ...icEntries];
}

describe("resolvePaperclipDesiredSkillNames — role-scoped filtering", () => {
  const entries = buildEntries();
  const config: Record<string, unknown> = {};
  const icSafeKeys = entries.filter((e) => !e.managerOnly).map((e) => e.key);

  it("role=engineer excludes manager-only skills", () => {
    const result = resolvePaperclipDesiredSkillNames(config, entries, "engineer");
    for (const key of MANAGER_ONLY_KEYS) {
      expect(result).not.toContain(key);
    }
    for (const key of icSafeKeys) {
      expect(result).toContain(key);
    }
  });

  it("role=qa excludes manager-only skills", () => {
    const result = resolvePaperclipDesiredSkillNames(config, entries, "qa");
    for (const key of MANAGER_ONLY_KEYS) {
      expect(result).not.toContain(key);
    }
    for (const key of icSafeKeys) {
      expect(result).toContain(key);
    }
  });

  it("role normalization: mixed case + whitespace", () => {
    const result = resolvePaperclipDesiredSkillNames(config, entries, "QA ");
    for (const key of MANAGER_ONLY_KEYS) {
      expect(result).not.toContain(key);
    }
    for (const key of icSafeKeys) {
      expect(result).toContain(key);
    }
  });

  it("role=null includes manager-only skills (back-compat)", () => {
    const result = resolvePaperclipDesiredSkillNames(config, entries, null);
    for (const key of MANAGER_ONLY_KEYS) {
      expect(result).toContain(key);
    }
    for (const key of icSafeKeys) {
      expect(result).toContain(key);
    }
  });

  it("role=general includes manager-only skills (fail-closed)", () => {
    const result = resolvePaperclipDesiredSkillNames(config, entries, "general");
    for (const key of MANAGER_ONLY_KEYS) {
      expect(result).toContain(key);
    }
  });

  it("non-IC roles (cto, ceo, designer) include manager-only skills", () => {
    for (const role of ["cto", "ceo", "designer"]) {
      const result = resolvePaperclipDesiredSkillNames(config, entries, role);
      for (const key of MANAGER_ONLY_KEYS) {
        expect(result).toContain(key);
      }
    }
  });

  it("explicit desiredSkills override: IC gets explicitly-desired manager-only skill", () => {
    const explicitConfig = {
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/autoplan"],
      },
    };
    const result = resolvePaperclipDesiredSkillNames(explicitConfig, entries, "engineer");
    expect(result).toContain("paperclipai/paperclip/autoplan");
    expect(result).not.toContain("paperclipai/paperclip/paperclip-create-agent");
    expect(result).not.toContain("paperclipai/paperclip/plan-ceo-review");
    for (const key of icSafeKeys) {
      expect(result).toContain(key);
    }
  });

  it("explicit managerOnly=false overrides runtimeName fallback for IC", () => {
    const entriesWithFallback = [
      ...entries.filter((e) => !e.managerOnly),
      {
        key: "custom-company/custom-ns/office-hours",
        runtimeName: "office-hours",
        required: true,
        managerOnly: false,
      },
    ];
    const result = resolvePaperclipDesiredSkillNames(config, entriesWithFallback, "engineer");
    expect(result).toContain("custom-company/custom-ns/office-hours");
  });

  it("managerOnly matched via runtimeName fallback is pruned when flag is unset", () => {
    const entriesWithFallback = [
      ...entries.filter((e) => !e.managerOnly),
      {
        key: "custom-company/custom-ns/office-hours",
        runtimeName: "office-hours",
        required: true,
      },
    ];
    const result = resolvePaperclipDesiredSkillNames(config, entriesWithFallback, "engineer");
    expect(result).not.toContain("custom-company/custom-ns/office-hours");
  });
});
