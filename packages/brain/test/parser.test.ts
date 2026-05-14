import { describe, it, expect } from "vitest";
import { parseNote } from "../src/indexer/parser.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vaultRoot = path.join(here, "fixtures/test-vault");

describe("parser", () => {
  it("extracts frontmatter, body, title, folder", async () => {
    const parsed = await parseNote(vaultRoot, "AI/sample.md");
    expect(parsed.path).toBe("AI/sample.md");
    expect(parsed.folder).toBe("AI");
    expect(parsed.title).toBe("LM Studio Setup");
    expect(parsed.frontmatter).toEqual({
      tags: ["ai", "lm-studio"],
      agent_exclude: ["CTO"],
    });
    expect(parsed.body).toContain("LM Studio");
    expect(parsed.sizeBytes).toBeGreaterThan(0);
    expect(parsed.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.mtime).toBeInstanceOf(Date);
  });

  it("falls back to filename when no H1 present", async () => {
    const parsed = await parseNote(vaultRoot, "AI/no-title.md");
    expect(parsed.title).toBe("no-title");
    expect(parsed.frontmatter).toEqual({});
  });
});
