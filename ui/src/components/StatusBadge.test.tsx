// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueStatusBadge, IssueStatusGlyph, StatusBadge } from "./StatusBadge";
import { brandChipBadge, issueStatusColor, statusBadgeClassic } from "../lib/status-colors";

// The brand chips ship behind the Conference Room Chat experimental flag
// (PAP-139). These suites were written against the NUX UI, so the flag is
// seeded ON; the classic-fallback suite below flips it OFF.
const conferenceRoomChatFlag = vi.hoisted(() => ({ enabled: true }));
vi.mock("../hooks/useConferenceRoomChatEnabled", () => ({
  useConferenceRoomChatEnabled: () => ({ enabled: conferenceRoomChatFlag.enabled, loaded: true }),
}));

afterEach(() => {
  conferenceRoomChatFlag.enabled = true;
});

/**
 * PAP-99 (PAP-95e): issue/task status chips adopt the PAP-75 brand palette and
 * carry their glyph icon. These tests lock the colour mapping ("blue =
 * liveness": todo → amber, in_progress → blue, in_review → violet) and assert a
 * glyph is always present, against the brand `.task-chip` tokens.
 */
describe("IssueStatusBadge", () => {
  it("maps each issue status to its PAP-75 brand colour token", () => {
    const cases: Record<string, keyof typeof brandChipBadge> = {
      backlog: "gray",
      todo: "amber",
      in_progress: "blue",
      in_review: "violet",
      done: "green",
      blocked: "red",
      cancelled: "gray",
    };
    for (const [status, color] of Object.entries(cases)) {
      expect(issueStatusColor[status]).toBe(color);
      const html = renderToStaticMarkup(<IssueStatusBadge status={status} />);
      // Brand chip carries a 1px border + the colour's light + dark classes.
      expect(html).toContain("border");
      expect(html).toContain(brandChipBadge[color].split(" ")[0]); // light bg hex
      // Every chip carries a glyph (inline SVG).
      expect(html).toContain("<svg");
      // Human-readable label, underscores spaced out.
      expect(html).toContain(status.replace(/_/g, " "));
    }
  });

  it("uses liveness blue for in_progress (not amber) and amber for todo (not blue)", () => {
    const prog = renderToStaticMarkup(<IssueStatusBadge status="in_progress" />);
    expect(prog).toContain("#DBEAFE"); // blue light bg
    expect(prog).not.toContain("#FEF3C7"); // not amber
    const todo = renderToStaticMarkup(<IssueStatusBadge status="todo" />);
    expect(todo).toContain("#FEF3C7"); // amber light bg
    expect(todo).not.toContain("#DBEAFE"); // not blue
  });

  it("renders in_review with the reserved violet token", () => {
    const html = renderToStaticMarkup(<IssueStatusBadge status="in_review" />);
    expect(html).toContain("#EDE9FE");
    expect(html).toContain("#7C3AED");
  });

  it("strikes through cancelled chips", () => {
    const html = renderToStaticMarkup(<IssueStatusBadge status="cancelled" />);
    expect(html).toContain("line-through");
  });

  it("falls back to the gray token for unknown statuses", () => {
    const html = renderToStaticMarkup(<IssueStatusBadge status="mystery" />);
    expect(html).toContain(brandChipBadge.gray.split(" ")[0]);
  });
});

describe("IssueStatusBadge — Conference Room Chat flag OFF (PAP-139)", () => {
  it("falls back to the plain master badge (no brand chip, no glyph)", () => {
    conferenceRoomChatFlag.enabled = false;
    const html = renderToStaticMarkup(<IssueStatusBadge status="in_progress" />);
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("#DBEAFE");
    // Master's StatusBadge markup with master's hues (in_progress → yellow).
    expect(html).toBe(renderToStaticMarkup(<StatusBadge status="in_progress" />));
    expect(html).toContain(statusBadgeClassic.in_progress!.split(" ")[0]); // bg-yellow-100
  });

  it("keeps master's blue todo / yellow in_progress palette on StatusBadge", () => {
    conferenceRoomChatFlag.enabled = false;
    expect(renderToStaticMarkup(<StatusBadge status="todo" />)).toContain("bg-blue-100");
    expect(renderToStaticMarkup(<StatusBadge status="in_progress" />)).toContain("bg-yellow-100");
  });

  it("uses the brand hues on StatusBadge when the flag is ON", () => {
    expect(renderToStaticMarkup(<StatusBadge status="todo" />)).toContain("bg-amber-100");
    expect(renderToStaticMarkup(<StatusBadge status="in_progress" />)).toContain("bg-blue-100");
  });
});

describe("IssueStatusGlyph", () => {
  it("gives in_progress a half-filled ring (liveness)", () => {
    const html = renderToStaticMarkup(<IssueStatusGlyph status="in_progress" />);
    // Open ring + the right-half semicircle fill path from status-reference.html.
    expect(html).toContain('d="M6 1.5 A4.5 4.5 0 0 1 6 10.5 Z"');
  });

  it("gives in_review a ring + centre dot (not a clock)", () => {
    const html = renderToStaticMarkup(<IssueStatusGlyph status="in_review" />);
    expect(html).toContain('r="2"');
  });

  it("gives done a filled circle with a knocked-out check", () => {
    const html = renderToStaticMarkup(<IssueStatusGlyph status="done" />);
    expect(html).toContain('d="M3.5 6 5.5 8 8.5 4.5"');
    expect(html).toContain("stroke-background");
  });

  it("gives blocked a ring + bar", () => {
    const html = renderToStaticMarkup(<IssueStatusGlyph status="blocked" />);
    expect(html).toContain("<rect");
  });

  it("gives backlog a dashed ring", () => {
    const html = renderToStaticMarkup(<IssueStatusGlyph status="backlog" />);
    expect(html).toContain('stroke-dasharray="2 2"');
  });

  it("gives cancelled a ring + slash", () => {
    const html = renderToStaticMarkup(<IssueStatusGlyph status="cancelled" />);
    expect(html).toContain('d="M3 9 9 3"');
  });
});
