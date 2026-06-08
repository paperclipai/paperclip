import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EntityRow } from "./EntityRow";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

describe("EntityRow", () => {
  it("keeps caller text color classes on linked rows", () => {
    const markup = renderToStaticMarkup(
      <EntityRow
        title="Left project"
        to="/projects/left-project"
        className="group text-foreground/55"
      />,
    );

    expect(markup).toContain("text-foreground/55");
    expect(markup).not.toContain("text-inherit");
  });

  it("renders an optional meta slot and stops the title from flex-growing", () => {
    const markup = renderToStaticMarkup(
      <EntityRow
        title="Alpha"
        meta={<span data-testid="meta-cell">gpt-5.4</span>}
        trailing={<span data-testid="trailing-cell">badge</span>}
      />,
    );

    // meta content renders alongside trailing
    expect(markup).toContain("meta-cell");
    expect(markup).toContain("trailing-cell");
    // a flex-1 spacer is inserted (between meta and trailing); the title block
    // itself no longer flex-grows
    expect(markup).toContain('class="flex-1"');
    expect(markup).not.toContain("min-w-0 flex-1");
  });

  it("keeps the title flex-growing when no meta is provided", () => {
    const markup = renderToStaticMarkup(<EntityRow title="Alpha" />);
    expect(markup).toContain("min-w-0 flex-1");
  });

  it("stacks title/meta/trailing below sm when responsive", () => {
    const markup = renderToStaticMarkup(
      <EntityRow
        title="Alpha"
        responsive
        meta={<span data-testid="meta-cell">draft</span>}
        trailing={<span data-testid="trailing-cell">2h</span>}
      />,
    );

    // inner wrapper stacks on mobile and reflows to a row at sm+
    expect(markup).toContain("flex flex-col gap-1.5 sm:flex-row");
    // the spacer that pins trailing right only exists at sm+ (no empty line on mobile)
    expect(markup).toContain("hidden sm:block sm:flex-1");
    // leading column top-aligns while stacked
    expect(markup).toContain("items-start sm:items-center");
    expect(markup).toContain("meta-cell");
    expect(markup).toContain("trailing-cell");
  });
});
