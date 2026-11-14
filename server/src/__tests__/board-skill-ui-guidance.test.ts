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

  it("keeps the overlay promise to the shortcut and describes the sidebar Search item as full search", () => {
    // The classic sidebar Search item is a link to the full search page, not the overlay.
    expect(read("ui/src/components/Sidebar.tsx")).toMatch(/<SidebarNavItem to="\/search" label="Search"/);
    expect(section).toMatch(/sidebar \*\*Search\*\* item[^\n]*opens the full search page/);
    expect(section).not.toMatch(/search icon[^\n]*opens over the current page/i);
  });

  it("does not claim operators narrow the quick-search results", () => {
    // The palette sends only the parsed free text; operators apply after the full-search handoff.
    expect(palette).toMatch(/issuesApi\.list\(selectedCompanyId!, \{ q: quickSearchQuery, limit: 10/);
    expect(section).toContain("they do not narrow the quick-search results");
  });

  it("tells the agent it cannot operate the person's browser", () => {
    expect(section).toMatch(/cannot press keys, focus fields, or open the palette/);
  });

  it("is discoverable from the skill description", () => {
    const frontmatter = skill.slice(0, skill.indexOf("\n---", 4));
    expect(frontmatter).toContain("finding things in the Paperclip web UI");
  });
});
