// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { AgentStatusBadge, IssueStatusBadge, StatusBadge } from "./StatusBadge";
import { agentStatusVar, taskStatusVar } from "../lib/status-colors";

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

  it("renders task chips without depending on the chat flag", () => {
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

describe("StatusBadge", () => {
  afterEach(async () => { await i18n.changeLanguage("en"); });

  it.each([
    ["waiting", "waiting", "Ожидание"],
    ["active", "active", "Активен"],
    ["in_progress", "in progress", "В работе"],
    ["RAW_unknown-state", "RAW unknown state", "RAW unknown state"],
  ])("preserves upstream English spelling and raw overrides for %s", async (status, english, russian) => {
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      expect(renderToStaticMarkup(<StatusBadge status={status} />)).toContain(`>${locale === "ru" ? russian : english}</span>`);
      expect(renderToStaticMarkup(<StatusBadge status={status} label="My raw label" />)).toContain(">My raw label</span>");
    }
  });

  it("uses the graduated brand hues", () => {
    expect(renderToStaticMarkup(<StatusBadge status="todo" />)).toContain("bg-amber-100");
    expect(renderToStaticMarkup(<StatusBadge status="in_progress" />)).toContain("bg-blue-100");
  });
});
