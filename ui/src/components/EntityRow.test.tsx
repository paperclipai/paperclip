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

  it("lets callers make the meta spacer responsive", () => {
    const markup = renderToStaticMarkup(
      <EntityRow
        title="Alpha"
        meta={<span data-testid="meta-cell">gpt-5.4</span>}
        trailing={<span data-testid="trailing-cell">badge</span>}
        metaSpacerClassName="hidden xl:block"
      />,
    );

    expect(markup).toContain('class="flex-1 hidden xl:block"');
  });

  it("keeps the title flex-growing when no meta is provided", () => {
    const markup = renderToStaticMarkup(<EntityRow title="Alpha" />);
    expect(markup).toContain("min-w-0 flex-1");
  });

  it("gives the title a min-width floor and lets meta shrink under titlePriority (PAP-12988)", () => {
    const markup = renderToStaticMarkup(
      <EntityRow
        title="Alpha"
        titlePriority
        meta={<span data-testid="meta-cell">chips</span>}
      />,
    );

    // The name keeps a usable floor instead of collapsing to zero...
    expect(markup).toContain("min-w-(--sz-6rem)");
    // ...and the meta cluster is the item that yields (shrinks), not the title.
    expect(markup).toContain("min-w-0 shrink");
    expect(markup).not.toContain('class="flex items-center gap-2 shrink-0"');
  });

  it("stacks a secondaryRow on its own line beneath the main row (PAP-12988)", () => {
    const markup = renderToStaticMarkup(
      <EntityRow
        title="Alpha"
        titlePriority
        meta={<span>chips-inline</span>}
        secondaryRow={<span data-testid="secondary-cell">chips-stacked</span>}
      />,
    );

    // The secondary content renders, and the shell switches from a single flex
    // row to a stacked block layout so the cluster gets its own full-width line.
    expect(markup).toContain("secondary-cell");
    expect(markup).toContain("chips-stacked");
    expect(markup).not.toMatch(/^<div class="flex items-center gap-3 px-4/);
  });
});
