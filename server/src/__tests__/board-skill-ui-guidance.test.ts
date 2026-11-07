import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relPath: string) => readFileSync(path.join(repoRoot, relPath), "utf8");

// Chat agents answer "how do I find X?" from the board skill; without this section they
// had no source for the web UI's quick search and told people to ask in chat instead.
describe("paperclip-board skill web UI guidance", () => {
  const skill = read("skills/paperclip-board/SKILL.md");
  const palette = read("ui/src/components/CommandPalette.tsx");
  const section = skill.slice(skill.indexOf("## Finding Things in the Web UI"), skill.indexOf("## Presentation Rules"));

  it("documents the quick-search shortcut the command palette actually binds", () => {
    expect(section.length).toBeGreaterThan(0);
    expect(palette).toMatch(/e\.key === "k" && \(e\.metaKey \|\| e\.ctrlKey\)/);
    expect(section).toContain("**Cmd+K**");
    expect(section).toContain("**Ctrl+K**");
  });

  it("documents the handoff to full search and the search route it opens", () => {
    expect(palette).toMatch(/event\.key === "Enter" && \(event\.metaKey \|\| event\.ctrlKey\)/);
    expect(palette).toContain("Search all for");
    expect(section).toContain("**Search all**");
    expect(section).toContain("Cmd/Ctrl+Enter");
    expect(read("ui/src/App.tsx")).toContain('<Route path="search"');
    expect(section).toContain("/{prefix}/search");
  });

  it("tells the agent it cannot operate the person's browser", () => {
    expect(section).toMatch(/cannot press keys, focus fields, or open the palette/);
  });

  it("is discoverable from the skill description", () => {
    const frontmatter = skill.slice(0, skill.indexOf("\n---", 4));
    expect(frontmatter).toContain("finding things in the Paperclip web UI");
  });
});
