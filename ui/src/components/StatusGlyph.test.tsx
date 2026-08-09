// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusGlyph } from "./StatusGlyph";
import { taskStatusIconVar } from "../lib/status-colors";

/**
 * PAP-238 3b: the unified status glyph renders every status from ONE
 * `viewBox="0 0 24 24"` SVG at a `sm 14 / md 16 / lg 20` scale, coloured from
 * the AA-tuned `--status-task-icon-*` vars. These tests lock the geometry (the
 * rev-4 spec hexes/paths), the size scale, the colour wiring and `in_queue`.
 */
describe("StatusGlyph", () => {
  it("renders one 24-unit viewBox for every status (proportional scaling)", () => {
    for (const status of Object.keys(taskStatusIconVar)) {
      const html = renderToStaticMarkup(<StatusGlyph status={status} />);
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).toContain("<svg");
    }
  });

  it("maps sm/md/lg to 14/16/20 px", () => {
    expect(renderToStaticMarkup(<StatusGlyph status="todo" size="sm" />)).toContain('width="14"');
    expect(renderToStaticMarkup(<StatusGlyph status="todo" size="md" />)).toContain('width="16"');
    expect(renderToStaticMarkup(<StatusGlyph status="todo" size="lg" />)).toContain('width="20"');
    // Default size is md.
    expect(renderToStaticMarkup(<StatusGlyph status="todo" />)).toContain('width="16"');
  });

  it("colours each status from its --status-task-icon-* var", () => {
    for (const [status, cssVar] of Object.entries(taskStatusIconVar)) {
      const html = renderToStaticMarkup(<StatusGlyph status={status} />);
      expect(html).toContain(`var(${cssVar})`);
    }
  });

  it("falls back to the backlog icon var for unknown statuses", () => {
    const html = renderToStaticMarkup(<StatusGlyph status="mystery" />);
    expect(html).toContain("var(--status-task-icon-backlog)");
  });

  it("gives backlog a uniform dashed ring (pathLength=100)", () => {
    const html = renderToStaticMarkup(<StatusGlyph status="backlog" />);
    expect(html).toContain('pathLength="100"');
    expect(html).toContain('stroke-dasharray="6.25 6.25"');
  });

  it("gives todo a bare open ring (no inner shape)", () => {
    const html = renderToStaticMarkup(<StatusGlyph status="todo" />);
    expect(html).toContain('r="8.5"');
    expect(html).not.toContain("<path");
    expect(html).not.toContain("<rect");
  });

  it("gives in_progress a half-filled ring (liveness)", () => {
    const html = renderToStaticMarkup(<StatusGlyph status="in_progress" />);
    expect(html).toContain("M12 3.5 A8.5 8.5 0 0 1 12 20.5 Z");
  });

  it("gives in_review a ring + centre dot", () => {
    const html = renderToStaticMarkup(<StatusGlyph status="in_review" />);
    expect(html).toContain('r="3.6"');
  });

  it("gives done a filled disc with a knocked-out check in the surface colour", () => {
    const html = renderToStaticMarkup(<StatusGlyph status="done" />);
    expect(html).toContain('r="9.5"');
    expect(html).toContain("M7.5 12.2 10.6 15.2 16.5 8.8");
    expect(html).toContain("stroke-background");
  });

  it("gives blocked a ring + bar", () => {
    const html = renderToStaticMarkup(<StatusGlyph status="blocked" />);
    expect(html).toContain("<rect");
    expect(html).toContain('width="10"');
  });

  it("gives cancelled a ring + slash", () => {
    const html = renderToStaticMarkup(<StatusGlyph status="cancelled" />);
    expect(html).toContain("M6.5 17.5 17.5 6.5");
  });

  it("renders in_queue as the blocked shape recoloured blue (in_progress var)", () => {
    const queue = renderToStaticMarkup(<StatusGlyph status="in_queue" />);
    const blocked = renderToStaticMarkup(<StatusGlyph status="blocked" />);
    // Same geometry as blocked (ring + bar)…
    expect(queue).toContain("<rect");
    expect(queue).toContain('width="10"');
    // …but coloured from the in_progress (blue) icon var, not blocked's red.
    expect(queue).toContain("var(--status-task-icon-in_queue)");
    expect(queue).not.toContain("var(--status-task-icon-blocked)");
    expect(blocked).toContain("var(--status-task-icon-blocked)");
  });

  it("is decorative by default and labelled when given a title", () => {
    expect(renderToStaticMarkup(<StatusGlyph status="todo" />)).toContain('aria-hidden="true"');
    const labelled = renderToStaticMarkup(<StatusGlyph status="todo" title="Todo" />);
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('aria-label="Todo"');
    expect(labelled).toContain("<title>Todo</title>");
  });
});
