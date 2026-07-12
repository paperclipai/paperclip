// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusGlyph } from "./StatusGlyph";
import { taskStatusIconVar } from "../lib/status-colors";

/**
 * The unified status glyph renders every status from ONE Lucide icon per status
 * (all on a shared `viewBox="0 0 24 24"`, at a `sm 14 / md 16 / lg 20` scale),
 * coloured from the AA-tuned `--status-task-icon-*` vars. These tests lock the
 * icon mapping, the size scale, the colour wiring and `in_queue`.
 */

/** Status → the Lucide class token its icon renders (`lucide-<kebab-name>`). */
const STATUS_ICON_CLASS: Record<string, string> = {
  backlog: "lucide-circle-dashed",
  todo: "lucide-circle",
  in_progress: "lucide-rotate-cw",
  in_review: "lucide-circle-dot",
  done: "lucide-circle-check",
  blocked: "lucide-circle-minus",
  cancelled: "lucide-ban",
  in_queue: "lucide-circle-minus",
};

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

  it("falls back to the backlog icon + var for unknown statuses", () => {
    const html = renderToStaticMarkup(<StatusGlyph status="mystery" />);
    expect(html).toContain("var(--status-task-icon-backlog)");
    expect(html).toContain("lucide-circle-dashed");
  });

  it("maps each status to its Lucide icon", () => {
    for (const [status, iconClass] of Object.entries(STATUS_ICON_CLASS)) {
      const html = renderToStaticMarkup(<StatusGlyph status={status} />);
      expect(html).toContain(iconClass);
    }
  });

  it("gives todo the plain circle (not a compound circle icon)", () => {
    const html = renderToStaticMarkup(<StatusGlyph status="todo" />);
    expect(html).toContain("lucide-circle");
    for (const compound of ["circle-dashed", "circle-dot", "circle-check", "circle-minus"]) {
      expect(html).not.toContain(compound);
    }
  });

  it("renders in_queue as the blocked icon recoloured blue (in_queue var)", () => {
    const queue = renderToStaticMarkup(<StatusGlyph status="in_queue" />);
    const blocked = renderToStaticMarkup(<StatusGlyph status="blocked" />);
    // Same icon as blocked (circle-minus)…
    expect(queue).toContain("lucide-circle-minus");
    // …but coloured from the in_queue (blue) icon var, not blocked's red.
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
