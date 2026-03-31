import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("paperclip skill auth contract", () => {
  it("documents structured runtime auth for non-local adapters", () => {
    const skillPath = path.resolve(process.cwd(), "skills/paperclip/SKILL.md");
    const text = fs.readFileSync(skillPath, "utf8");

    expect(text).toContain("structured runtime auth for cloud/non-local adapters: `paperclip.auth` metadata in the wake payload");
    expect(text).toContain("Do not scrape `PAPERCLIP_API_KEY` from `payloadTemplate.message` or other prompt text.");
    expect(text).toContain("Do not use shared claimed-key files or ad-hoc local artifacts as the steady-state auth source.");
    expect(text).toContain("Authorization: Bearer <Paperclip runtime auth token>");
  });
});
