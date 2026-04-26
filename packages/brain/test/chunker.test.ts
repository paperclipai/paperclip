import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "../src/indexer/chunker.js";

describe("chunker", () => {
  it("returns single chunk for short note", () => {
    const chunks = chunkMarkdown("# Hello\n\nShort body.", { maxTokens: 800, overlapTokens: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain("Hello");
    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks[0]!.headingPath).toEqual(["Hello"]);
  });

  it("splits at heading boundaries when content exceeds maxTokens", () => {
    const longBody = "word ".repeat(1500);
    const md = `# H1 Title\n\n${longBody}\n\n## H2 Section\n\n${longBody}`;
    const chunks = chunkMarkdown(md, { maxTokens: 800, overlapTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(1100);
    }
    const h2Chunk = chunks.find((c) => c.headingPath.includes("H2 Section"));
    expect(h2Chunk).toBeDefined();
  });

  it("never splits inside a fenced code block", () => {
    const codeBlock = "```python\n" + "print('x')\n".repeat(200) + "```";
    const md = `# Code\n\n${codeBlock}\n\n## After\n\nTrailing text.`;
    const chunks = chunkMarkdown(md, { maxTokens: 800, overlapTokens: 100 });
    for (const c of chunks) {
      const opens = (c.content.match(/```/g) ?? []).length;
      expect(opens % 2).toBe(0);
    }
  });

  it("tracks heading breadcrumb (heading_path)", () => {
    const md = "# Top\n\nIntro\n\n## Middle\n\nMid\n\n### Leaf\n\nLeaf body";
    const chunks = chunkMarkdown(md, { maxTokens: 800, overlapTokens: 100 });
    const leafChunk = chunks.find((c) => c.content.includes("Leaf body"));
    expect(leafChunk?.headingPath).toEqual(["Top", "Middle", "Leaf"]);
  });

  it("returns no chunks for empty body", () => {
    const chunks = chunkMarkdown("", { maxTokens: 800, overlapTokens: 100 });
    expect(chunks).toEqual([]);
  });
});
