import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { stockHarnessSourceDigest, stockHarnessSkillSources } from "./stock-harness.js";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(), readFileSync: vi.fn() }));

describe("stock harness instruction revision", () => {
  it.each(["server/src/onboarding-assets/default/AGENTS.md", "packages/adapter-utils/src/server-utils.ts", "packages/shared/src/connection-intent-guidance.ts", "skills/paperclip/SKILL.md", "skills/paperclip/references/issue-documents.md", "packages/paperclip-runner/generated/capability/capabilities.yaml", "packages/paperclip-runner/spec/capability/capabilities.yaml", "tests/runner-e2e/stock-harness-manifest.ts", "packages/adapter-utils/src/acpx-engine/execute.ts", "packages/adapter-utils/src/acpx-engine/ephemeral-session-environment.ts", "tests/runner-e2e/stock-harness-instruction-variant.mjs", "tests/runner-e2e/automatic-retry.ts", "tests/runner-e2e/catalog.ts"])(
    "changes when the evaluated %s changes", source => {
      vi.mocked(readFileSync).mockImplementation(() => Buffer.from("unchanged"));
      const original = stockHarnessSourceDigest();
      vi.mocked(readFileSync).mockImplementation(file => Buffer.from(String(file).endsWith(source) ? "changed instructions" : "unchanged"));
      expect(stockHarnessSourceDigest()).not.toBe(original);
    });
  it("records an absent historical recipe without introducing its content or hiding other read errors", () => {
    vi.mocked(readFileSync).mockImplementation(() => Buffer.from("unchanged"));
    const present = stockHarnessSourceDigest();
    vi.mocked(readFileSync).mockImplementation(file => {
      if (String(file).endsWith("references/issue-documents.md")) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return Buffer.from("unchanged");
    });
    expect(stockHarnessSkillSources()[1]).toEqual({ path: "skills/paperclip/references/issue-documents.md", present: false, sha256: null });
    expect(stockHarnessSourceDigest()).not.toBe(present);
    vi.mocked(readFileSync).mockImplementation(() => { throw Object.assign(new Error("unreadable"), { code: "EACCES" }); });
    expect(stockHarnessSourceDigest).toThrow("unreadable");
  });
});
