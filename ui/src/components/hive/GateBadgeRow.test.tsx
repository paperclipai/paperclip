// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { IssueGateSummary } from "@paperclipai/shared";
import { GateBadgeRow } from "./GateBadgeRow";

let root: ReturnType<typeof createRoot> | null = null;

function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(node));
  return container;
}

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("GateBadgeRow", () => {
  it("renders a chip per gate with its label", () => {
    const summary: IssueGateSummary = {
      gates: [
        { type: "gate_plan_approval", status: "approved" },
        { type: "gate_code_review", status: "pending" },
        { type: "gate_wiring_review", status: "rejected" },
      ],
    };
    const c = render(<GateBadgeRow summary={summary} />);
    expect(c.textContent).toContain("plan");
    expect(c.textContent).toContain("code");
    expect(c.textContent).toContain("wiring");
    // one chip per gate
    expect(c.querySelectorAll("span[title]").length).toBe(3);
  });

  it("encodes each status in the chip title", () => {
    const summary: IssueGateSummary = {
      gates: [
        { type: "gate_plan_approval", status: "approved" },
        { type: "gate_code_review", status: "revision_requested" },
      ],
    };
    const c = render(<GateBadgeRow summary={summary} />);
    const titles = [...c.querySelectorAll("span[title]")].map((s) => s.getAttribute("title"));
    expect(titles).toContain("plan: approved");
    expect(titles).toContain("code: revision requested");
  });

  it("renders nothing when there are no gates", () => {
    const c = render(<GateBadgeRow summary={{ gates: [] }} />);
    expect(c.querySelectorAll("span[title]").length).toBe(0);
  });
});
