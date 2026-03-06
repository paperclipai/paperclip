import { describe, expect, it } from "vitest";
import {
  buildIssuePrefixCandidate,
  createProjectSchema,
  deriveIssuePrefixBase,
  updateProjectSchema,
} from "@paperclipai/shared";

describe("issue prefix derivation helpers", () => {
  it("derives a three-letter uppercase base from names", () => {
    expect(deriveIssuePrefixBase("Paperclip Platform")).toBe("PAP");
    expect(deriveIssuePrefixBase("cli")).toBe("CLI");
    expect(deriveIssuePrefixBase("N2M!")).toBe("NM");
  });

  it("falls back to CMP when a name has no letters", () => {
    expect(deriveIssuePrefixBase("1234 !!!")).toBe("CMP");
  });

  it("builds deterministic suffix candidates for collisions", () => {
    expect(buildIssuePrefixCandidate("PAP", 1)).toBe("PAP");
    expect(buildIssuePrefixCandidate("PAP", 2)).toBe("PAPA");
    expect(buildIssuePrefixCandidate("PAP", 3)).toBe("PAPAA");
  });
});

describe("project issuePrefix validation", () => {
  it("accepts and normalizes user-provided issuePrefix on create", () => {
    const parsed = createProjectSchema.parse({
      name: "Control Plane",
      issuePrefix: "pcp",
    });
    expect(parsed.issuePrefix).toBe("PCP");
  });

  it("accepts and normalizes user-provided issuePrefix on update", () => {
    const parsed = updateProjectSchema.parse({
      issuePrefix: "cli",
    });
    expect(parsed.issuePrefix).toBe("CLI");
  });

  it("rejects non-letter prefixes", () => {
    const parsed = createProjectSchema.safeParse({
      name: "Bad Prefix",
      issuePrefix: "P4P",
    });
    expect(parsed.success).toBe(false);
  });
});
