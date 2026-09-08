// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectAutomationCard } from "./ProjectAutomationCard";

const listLabelsMock = vi.hoisted(() => vi.fn());

vi.mock("../api/issues", () => ({
  issuesApi: {
    listLabels: (companyId: string) => listLabelsMock(companyId),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

function renderCard(props: {
  automationPolicy?: { autoLabelRules: Array<{ id: string; match: string; labelId: string }> } | null;
  onSave?: (policy: unknown) => void;
}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = (
    <QueryClientProvider client={queryClient}>
      <ProjectAutomationCard
        companyId="company-1"
        projectId="project-1"
        automationPolicy={props.automationPolicy ?? null}
        onSave={props.onSave ?? vi.fn()}
        isSaving={false}
      />
    </QueryClientProvider>
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

async function flushReact() {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
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
  vi.clearAllMocks();
});

describe("ProjectAutomationCard", () => {
  it("renders stored rules with label names and an empty state", async () => {
    listLabelsMock.mockResolvedValue([{ id: "label-1", name: "urgent", color: "red" }]);
    const rendered = renderCard({
      automationPolicy: { autoLabelRules: [{ id: "r1", match: "outage", labelId: "label-1" }] },
    });
    await flushReact();
    expect(rendered.textContent).toContain("outage");
    expect(rendered.textContent).toContain("urgent");
    expect(rendered.querySelector('ul[aria-label="Auto-label rules"]')).toBeTruthy();

    const empty = renderCard({ automationPolicy: null });
    await flushReact();
    expect(empty.textContent).toContain("No rules yet");
  });

  it("deletes a rule and saves the remainder", async () => {
    listLabelsMock.mockResolvedValue([{ id: "label-1", name: "urgent", color: "red" }]);
    const onSave = vi.fn();
    const rendered = renderCard({
      automationPolicy: {
        autoLabelRules: [
          { id: "r1", match: "outage", labelId: "label-1" },
          { id: "r2", match: "leak", labelId: "label-1" },
        ],
      },
      onSave,
    });
    await flushReact();

    const saveButton = Array.from(rendered.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save rules"),
    );
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);

    const deleteButton = rendered.querySelector('button[aria-label="Delete rule for outage"]');
    expect(deleteButton).toBeTruthy();
    if (typeof reactAct === "function") {
      await reactAct(async () => {
        (deleteButton as HTMLButtonElement).click();
      });
    } else {
      (deleteButton as HTMLButtonElement).click();
    }
    await flushReact();

    expect(rendered.textContent).not.toContain("outage");
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    if (typeof reactAct === "function") {
      await reactAct(async () => {
        (saveButton as HTMLButtonElement).click();
      });
    } else {
      (saveButton as HTMLButtonElement).click();
    }
    expect(onSave).toHaveBeenCalledWith({
      autoLabelRules: [{ id: "r2", match: "leak", labelId: "label-1" }],
    });
  });

  it("rejects an empty match without touching the draft", async () => {
    listLabelsMock.mockResolvedValue([]);
    const onSave = vi.fn();
    const rendered = renderCard({ automationPolicy: null, onSave });
    await flushReact();

    const addButton = Array.from(rendered.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add rule"),
    );
    if (typeof reactAct === "function") {
      await reactAct(async () => {
        (addButton as HTMLButtonElement).click();
      });
    } else {
      (addButton as HTMLButtonElement).click();
    }
    await flushReact();
    expect(rendered.textContent).toContain("Enter text to match");
    expect(onSave).not.toHaveBeenCalled();
  });
});
