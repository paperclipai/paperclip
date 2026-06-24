// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStatusBadge, IssueStatusBadge, StatusBadge } from "./StatusBadge";
import { agentStatusVar, statusBadgeClassic, taskStatusVar } from "../lib/status-colors";

// The generic StatusBadge (runs/goals/approvals) keeps the PAP-75 brand palette
// behind the Conference Room Chat flag (PAP-139). Seeded ON; the suite below
// flips it OFF. The task/agent status chips no longer depend on this flag.
const conferenceRoomChatFlag = vi.hoisted(() => ({ enabled: true }));
vi.mock("../hooks/useConferenceRoomChatEnabled", () => ({
  useConferenceRoomChatEnabled: () => ({ enabled: conferenceRoomChatFlag.enabled, loaded: true }),
}));

afterEach(() => {
  conferenceRoomChatFlag.enabled = true;
});

/**
 * Issue/task status chips carry the unified glyph and are recolored from the
 * `--status-task-*` base hue via the `.status-chip` color-mix helper.
 */
describe("IssueStatusBadge", () => {
  it("wires each issue status to its --status-task-* base hue, with a glyph", () => {
    for (const [status, cssVar] of Object.entries(taskStatusVar)) {
      const html = renderToStaticMarkup(<IssueStatusBadge status={status} />);
      expect(html).toContain("status-chip");
      expect(html).toContain("border");
      expect(html).toContain(`var(${cssVar})`);
      expect(html).toContain('viewBox="0 0 24 24"'); // unified glyph
    }
  });

  it("points in_progress at the blue liveness var and todo at the amber var", () => {
    expect(renderToStaticMarkup(<IssueStatusBadge status="in_progress" />)).toContain("var(--status-task-in_progress)");
    expect(renderToStaticMarkup(<IssueStatusBadge status="todo" />)).toContain("var(--status-task-todo)");
  });

  it("sentence-cases the label and uses regular weight", () => {
    const html = renderToStaticMarkup(<IssueStatusBadge status="in_review" />);
    expect(html).toContain("In review");
    expect(html).not.toContain("In Review"); // sentence case, not title case
    expect(html).toContain("font-normal");
    expect(html).not.toContain("font-medium");
  });

  it("strikes through cancelled chips", () => {
    expect(renderToStaticMarkup(<IssueStatusBadge status="cancelled" />)).toContain("line-through");
  });

  it("falls back to the backlog (gray) var for unknown statuses", () => {
    expect(renderToStaticMarkup(<IssueStatusBadge status="mystery" />)).toContain("var(--status-task-backlog)");
  });

  it("is independent of the Conference Room Chat flag", () => {
    conferenceRoomChatFlag.enabled = false;
    const html = renderToStaticMarkup(<IssueStatusBadge status="todo" />);
    expect(html).toContain("status-chip");
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain("Todo");
  });
});

/** Agent chips recolor from the `--status-agent-*` base hues. */
describe("AgentStatusBadge", () => {
  it("wires each agent status to its --status-agent-* base hue via status-chip", () => {
    for (const [status, cssVar] of Object.entries(agentStatusVar)) {
      const html = renderToStaticMarkup(<AgentStatusBadge status={status} />);
      expect(html).toContain("status-chip");
      expect(html).toContain(`var(${cssVar})`);
    }
  });

  it('renders "active" as the idle label', () => {
    expect(renderToStaticMarkup(<AgentStatusBadge status="active" />)).toContain("idle");
  });
});

/** The generic badge still honors the PAP-139 Conference Room Chat palette. */
describe("StatusBadge — Conference Room Chat flag palettes (PAP-139)", () => {
  it("keeps master's blue todo / yellow in_progress palette when the flag is OFF", () => {
    conferenceRoomChatFlag.enabled = false;
    expect(renderToStaticMarkup(<StatusBadge status="todo" />)).toContain("bg-blue-100");
    expect(renderToStaticMarkup(<StatusBadge status="in_progress" />)).toContain("bg-yellow-100");
    expect(renderToStaticMarkup(<StatusBadge status="in_progress" />)).toContain(
      statusBadgeClassic.in_progress!.split(" ")[0],
    );
  });

  it("uses the brand hues when the flag is ON", () => {
    expect(renderToStaticMarkup(<StatusBadge status="todo" />)).toContain("bg-amber-100");
    expect(renderToStaticMarkup(<StatusBadge status="in_progress" />)).toContain("bg-blue-100");
  });
});
