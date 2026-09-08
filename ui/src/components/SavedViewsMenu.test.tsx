// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SavedViewsMenu } from "./SavedViewsMenu";
import {
  persistSavedViews,
  savedViewsStorageKey,
} from "../lib/saved-issue-views";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type ViewState = { statuses: string[] };
type Column = "status" | "id";

const normalizers = {
  normalizeViewState: (value: unknown): ViewState => {
    const candidate = value as Partial<ViewState> | null;
    return {
      statuses: Array.isArray(candidate?.statuses)
        ? candidate.statuses.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  },
  normalizeColumns: (value: unknown): Column[] => Array.isArray(value)
    ? (value as unknown[]).filter((entry): entry is Column => entry === "status" || entry === "id")
    : ["status"],
};

const location = { companyId: "company-1", collectionKey: "tasks" };

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

function renderMenu() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const element = (
    <SavedViewsMenu
      companyId="company-1"
      collectionKey="tasks"
      snapshotViewState={{ statuses: [] }}
      snapshotColumns={["status"]}
      normalizers={normalizers}
      onApply={vi.fn()}
    />
  );
  if (typeof reactAct === "function") {
    reactAct(() => {
      root!.render(element);
    });
  } else {
    flushSync(() => {
      root!.render(element);
    });
  }
  return container;
}

afterEach(() => {
  if (typeof reactAct === "function") {
    reactAct(() => {
      root?.unmount();
    });
  } else {
    root?.unmount();
  }
  container?.remove();
  root = null;
  container = null;
  window.localStorage.removeItem(savedViewsStorageKey(location));
});

describe("SavedViewsMenu", () => {
  it("renders a Views trigger without a count when nothing is saved", () => {
    const rendered = renderMenu();
    const trigger = rendered.querySelector("button[aria-label='Saved views']");
    expect(trigger?.textContent).toContain("Views");
    expect(trigger?.textContent).not.toMatch(/\d/);
  });

  it("shows the saved view count from storage", () => {
    persistSavedViews(location, [{
      id: "view-1",
      name: "Blocked work",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      viewState: { statuses: ["blocked"] },
      columns: ["status"],
    }]);
    const rendered = renderMenu();
    const trigger = rendered.querySelector("button[aria-label='Saved views (1)']");
    expect(trigger?.textContent).toContain("1");
  });
});
