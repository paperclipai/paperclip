// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ActivityEvent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedCard } from "./FeedCard";
import { i18n } from "@/i18n";

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

  it.each([["waiting", "moved to idle"], [null, "moved to in review"]])("distinguishes waiting from review (%s)", (state, verb) => {
    const root = createRoot(container);
    act(() => root.render(<FeedCard event={{ ...event, details: { status: "in_review", externalConversationState: state } }} agentMap={new Map()} entityNameMap={new Map()} entityTitleMap={new Map()} />));
    expect(container.querySelector('[data-fc="verb"]')?.textContent).toBe(verb);
    act(() => root.unmount());
  });

  it("updates waiting-state wording without changing the event or remounting its link", async () => {
    const waiting = { ...event, details: { status: "in_review", externalConversationState: "waiting" } };
    const original = JSON.stringify(waiting);
    const root = createRoot(container);
    await act(async () => root.render(<FeedCard event={waiting} agentMap={new Map()} entityNameMap={new Map()} entityTitleMap={new Map()} />));
    const link = container.querySelector('[data-fc="link"]');
    try {
      for (const language of ["ru", "en", "ru"]) {
        await act(async () => { await i18n.changeLanguage(language); });
        const verb = container.querySelector('[data-fc="verb"]')?.textContent ?? "";
        if (language === "en") expect(verb).toBe("moved to idle");
        else expect(verb).toMatch(/[А-Яа-яЁё]/);
        expect(container.querySelector('[data-fc="link"]')).toBe(link);
        expect(JSON.stringify(waiting)).toBe(original);
      }
    } finally {
      await act(async () => { await i18n.changeLanguage("en"); root.unmount(); });
    }
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
