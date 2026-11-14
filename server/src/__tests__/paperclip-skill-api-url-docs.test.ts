import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const skillMarkdown = await readFile(
  new URL("../../../skills/paperclip/SKILL.md", import.meta.url),
  "utf8",
);

describe("paperclip skill API URL guidance", () => {
  it("states that PAPERCLIP_API_URL is the server root without the /api prefix", () => {
    expect(skillMarkdown).toContain(
      "`PAPERCLIP_API_URL` holds the server root and does NOT include the `/api` prefix",
    );
  });

  it("provides the deterministic /api normalization recipe", () => {
    expect(skillMarkdown).toContain(
      'PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"',
    );
    expect(skillMarkdown).toContain(
      'PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"',
    );
  });

  it("warns that an unprefixed request returns the SPA HTML with HTTP 200", () => {
    expect(skillMarkdown).toContain(
      "returns the web app's HTML page with HTTP 200, not an API error",
    );
  });
});
