// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BriefCard } from "../../src/contracts.js";
import { makeCard, makeSnapshot, makeTaskRow } from "./fixtures.js";

const actionCalls = vi.hoisted(() => ({
  pin: vi.fn(async () => ({ ok: true })),
  dismiss: vi.fn(async () => ({ ok: true })),
}));

let mockPageData: { cards: BriefCard[]; fetchedAt: string };

vi.mock("@paperclipai/plugin-sdk/ui", () => {
  return {
    ManagedRoutinesList: () => null,
    IssueRow: ({ issue, trailingMeta, className }: { issue: { identifier?: string | null; title: string }; trailingMeta?: ReactNode; className?: string }) => (
      <a data-plugin-issue-row={issue.identifier ?? ""} className={className} href={`/issues/${issue.identifier ?? ""}`}>{issue.identifier} {issue.title} {trailingMeta}</a>
    ),
    useHostNavigation: () => ({
      resolveHref: (to: string) => to,
      navigate: () => {},
      linkProps: (to: string) => ({ href: to, onClick: () => {} }),
    }),
    useHostContext: () => ({
      companyId: "company-1",
      companyPrefix: "PAP",
      projectId: null,
      entityId: null,
      entityType: null,
      userId: "user-1",
    }),
    usePluginAction: (key: string) => {
      if (key === "pin-card") return actionCalls.pin;
      if (key === "dismiss-card") return actionCalls.dismiss;
      return vi.fn(async () => ({ ok: true }));
    },
    usePluginData: (key: string) => {
      if (key === "page") {
        return { data: mockPageData, loading: false, error: null, refresh: vi.fn() };
      }
      return { data: null, loading: false, error: null, refresh: vi.fn() };
    },
    usePluginToast: () => vi.fn(),
  };
});

import { BriefingPage } from "../../src/ui/app.js";

const hostContext = {
  companyId: "company-1",
  companyPrefix: "PAP",
  projectId: null,
  entityId: null,
  entityType: null,
  userId: "user-1",
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeCards(): BriefCard[] {
  const newest = makeCard({
    id: "card-new",
    title: "Newest unpinned work",
    pinned: false,
    lastMeaningfulEventAt: "2026-05-23T11:00:00.000Z",
    snapshot: makeSnapshot({
      taskRows: [makeTaskRow({ identifier: "PAP-1", titleLine: "Newest issue" })],
    }),
  });
  const older = makeCard({
    id: "card-old",
    title: "Older unpinned work",
    pinned: false,
    lastMeaningfulEventAt: "2026-05-22T11:00:00.000Z",
    snapshot: makeSnapshot({
      taskRows: [makeTaskRow({ identifier: "PAP-2", titleLine: "Older issue" })],
    }),
  });
  return [newest, older];
}

describe("BriefingPage interactions", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockPageData = { cards: makeCards(), fetchedAt: "2026-05-23T12:00:00.000Z" };
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function renderPage() {
    flushSync(() => {
      root.render(<BriefingPage context={hostContext as never} />);
    });
  }

  it("pins optimistically and moves the card to the top without a full refresh", async () => {
    renderPage();

    const oldCard = [...container.querySelectorAll("article[data-briefs-card]")]
      .find((node) => node.textContent?.includes("Older unpinned work"));
    const pinButton = oldCard?.querySelector('button[aria-label="Pin card"]') as HTMLButtonElement | null;
    expect(pinButton).not.toBeNull();

    flushSync(() => {
      pinButton?.click();
    });

    const titles = [...container.querySelectorAll("article[data-briefs-card] h3")].map((node) => node.textContent);
    expect(titles[0]).toBe("Older unpinned work");
    expect(actionCalls.pin).toHaveBeenCalledWith(expect.objectContaining({
      cardId: "card-old",
      pinned: true,
    }));
  });

  it("starts the dismiss fade immediately and persists the hidden card", async () => {
    renderPage();

    const firstCard = container.querySelector("article[data-briefs-card]") as HTMLElement | null;
    const dismissButton = firstCard?.querySelector('button[aria-label="Dismiss briefing card"]') as HTMLButtonElement | null;
    expect(firstCard).not.toBeNull();
    expect(dismissButton).not.toBeNull();

    flushSync(() => {
      dismissButton?.click();
    });

    expect(firstCard?.style.opacity).toBe("0");
    expect(actionCalls.dismiss).toHaveBeenCalledWith(expect.objectContaining({
      cardId: "card-new",
    }));
  });
});
