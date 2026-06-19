import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectTile } from "./ProjectTile";

describe("ProjectTile", () => {
  it("renders a neutral gray folder tile by default", () => {
    const markup = renderToStaticMarkup(<ProjectTile />);
    // Neutral tile uses the muted token, never an inline background color.
    expect(markup).toContain("bg-muted");
    expect(markup).toContain("text-muted-foreground");
    expect(markup).not.toContain("background-color");
    // Folder icon is the default when no icon prop is supplied.
    expect(markup).toContain("lucide-folder");
  });

  it("renders the chosen Lucide icon when an icon prop is provided", () => {
    const markup = renderToStaticMarkup(<ProjectTile icon="rocket" />);
    expect(markup).toContain("lucide-rocket");
    expect(markup).not.toContain("lucide-folder");
  });

  it("falls back to the folder icon for an unknown icon name", () => {
    const markup = renderToStaticMarkup(<ProjectTile icon="not-a-real-icon" />);
    expect(markup).toContain("lucide-folder");
  });

  it("tints the background when a color is provided", () => {
    const markup = renderToStaticMarkup(<ProjectTile color="#22c55e" />);
    expect(markup).toContain("background-color:#22c55e");
    expect(markup).toContain("text-white");
    // Tinted tile drops the muted neutral background.
    expect(markup).not.toContain("bg-muted");
    expect(markup).toContain("lucide-folder");
  });

  it("treats null color as neutral (not tinted)", () => {
    const markup = renderToStaticMarkup(<ProjectTile color={null} />);
    expect(markup).toContain("bg-muted");
    expect(markup).not.toContain("background-color");
  });

  it("applies size styles", () => {
    const markup = renderToStaticMarkup(<ProjectTile size="lg" />);
    expect(markup).toContain("h-9 w-9");
  });
});
