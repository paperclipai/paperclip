// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ActivityEvent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedCard } from "./FeedCard";

const navigate = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ children, issueQuicklookSide: _, to, ...props }: React.ComponentProps<"a"> & { issueQuicklookSide?: string; to: string }) => (
    <a {...props} href={to} onClick={navigate}>
      {children}
    </a>
  ),
}));

const event: ActivityEvent = {
  id: "event-1",
  companyId: "company-1",
  actorType: "user",
  actorId: "user-1",
  action: "issue.updated",
  entityType: "issue",
  entityId: "issue-1",
  agentId: null,
  runId: null,
  details: null,
  createdAt: new Date("2026-09-11T12:00:00.000Z"),
};

describe("FeedCard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    navigate.mockClear();
  });

  afterEach(() => {
    container.remove();
  });

  it("uses the whole visible card as the entity link", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <FeedCard
          event={event}
          agentMap={new Map()}
          entityNameMap={new Map([["issue:issue-1", "PAP-1"]])}
          entityTitleMap={new Map([["issue:issue-1", "Clickable card"]])}
        />,
      );
    });

    const link = container.querySelector<HTMLAnchorElement>('[data-fc="link"]');
    const card = container.querySelector<HTMLElement>('[data-fc="card"]');

    expect(link).not.toBeNull();
    expect(link?.className).toContain("w-full");
    expect(card?.className).toContain("w-(--sz-calc-1)");
    expect(card?.className).toContain("md:w-(--sz-calc-2)");
    expect(link?.contains(card ?? null)).toBe(true);

    card?.click();
    expect(navigate).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });
});
