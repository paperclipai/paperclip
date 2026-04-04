// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewGoalDialog } from "./NewGoalDialog";

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    newGoalOpen: true,
    newGoalDefaults: {},
    closeNewGoal: () => {},
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: {
      id: "company-1",
      name: "Acme",
    },
  }),
}));

vi.mock("../api/goals", () => ({
  goalsApi: {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({})),
  },
}));

vi.mock("../api/assets", () => ({
  assetsApi: {
    uploadImage: vi.fn(async () => ({ contentPath: "/api/assets/test" })),
  },
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({
    contentClassName,
  }: {
    contentClassName?: string;
  }) => <div data-testid="goal-markdown-editor" className={contentClassName}>Editor</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("NewGoalDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("keeps long descriptions inside a bounded scrollable dialog body", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NewGoalDialog />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    const dialogContent = document.querySelector('[data-slot="dialog-content"]');
    expect(dialogContent?.className).toContain("max-h-[calc(100dvh-2rem)]");
    expect(dialogContent?.className).toContain("flex");
    expect(dialogContent?.className).toContain("flex-col");

    const descriptionWrapper = document.querySelector(".overflow-y-auto.min-h-0");
    expect(descriptionWrapper).not.toBeNull();
    expect(document.body.textContent).toContain("Create goal");

    await act(async () => {
      root.unmount();
    });
  });
});
