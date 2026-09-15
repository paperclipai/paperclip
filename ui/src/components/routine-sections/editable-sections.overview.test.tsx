// @vitest-environment jsdom

import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewSection } from "./editable-sections";
import { RoutineDetailContext, type RoutineDetailContextValue, type RoutineEditDraft } from "./context";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The real MarkdownEditor (MDXEditor) fires onChange once while it mounts,
// with the imported Markdown re-serialized/normalized, even with no user
// input. Mock it as a controlled <textarea> that reproduces exactly that: a
// mount-only layout effect calls onChange with a value DIFFERENT from its
// `value` prop (appending a trailing newline, like real normalization does),
// then it behaves like a normal controlled input for subsequent typing.
vi.mock("../MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => {
    const mountedRef = useRef(false);
    useLayoutEffect(() => {
      if (mountedRef.current) return;
      mountedRef.current = true;
      onChange(`${value}\n`);
      // Mount-only: intentionally ignore `value`/`onChange` identity churn.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <textarea
        data-testid="description-editor"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  },
}));

function act(callback: () => void) {
  flushSync(callback);
}

function makeDraft(overrides: Partial<RoutineEditDraft> = {}): RoutineEditDraft {
  return {
    title: "My routine",
    description: "Original description",
    projectId: "",
    assigneeAgentId: "agent-1",
    priority: "medium",
    concurrencyPolicy: "queue",
    catchUpPolicy: "skip",
    activityGatePolicy: "none",
    activityGateScope: "none",
    variables: [],
    env: null,
    ...overrides,
  };
}

function Harness({ onDescriptionDirtyChange }: { onDescriptionDirtyChange: (dirty: boolean) => void }) {
  const originalDescription = "Original description";
  const [editDraft, setEditDraft] = useState<RoutineEditDraft>(makeDraft());

  // Report dirtiness the same way RoutineDetail derives it: by diffing the
  // live draft against the unedited original (see RoutineDetail.tsx's
  // `dirtyFields`/`isSectionDirty`, which the Save bar reads from).
  onDescriptionDirtyChange(editDraft.description !== originalDescription);

  const isSectionDirty = (section: string) =>
    section === "overview" && editDraft.description !== originalDescription;

  const value = {
    routine: {
      id: "routine-1",
      triggers: [],
      assigneeAgentId: "agent-1",
      descriptionDocument: null,
    },
    editDraft,
    setEditDraft,
    assigneeOptions: [],
    projectOptions: [],
    recentAssigneeIds: [],
    recentProjectIds: [],
    agentById: new Map(),
    projectById: new Map(),
    currentAssignee: null,
    currentProject: null,
    mentionOptions: [],
    assigneeSelectorRef: { current: null },
    projectSelectorRef: { current: null },
    descriptionEditorRef: { current: null },
    routineRuns: [],
    activity: [],
    saveRoutine: { isPending: false, mutate: vi.fn() },
    saveConflict: false,
    isSectionDirty,
    navigateToSection: vi.fn(),
  } as unknown as RoutineDetailContextValue;

  return (
    <RoutineDetailContext.Provider value={value}>
      <OverviewSection />
    </RoutineDetailContext.Provider>
  );
}

describe("OverviewSection description editor", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    container.remove();
    document.body.innerHTML = "";
  });

  it("ignores mount-time markdown normalization until the user interacts", () => {
    const onDescriptionDirtyChange = vi.fn();
    root = createRoot(container);

    act(() => {
      root?.render(<Harness onDescriptionDirtyChange={onDescriptionDirtyChange} />);
    });

    // The mocked editor's mount-only layout effect has already fired by now.
    const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="description-editor"]');
    expect(editor).not.toBeNull();
    // The mount-time normalization must not have flowed into the draft.
    expect(editor?.value).toBe("Original description");
    expect(onDescriptionDirtyChange).not.toHaveBeenCalledWith(true);

    // A real interaction (keydown capture fires before the change event)
    // arms the gate, so the next onChange IS treated as dirty.
    act(() => {
      editor?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    });
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(editor, "Original description edited");
      editor?.dispatchEvent(new Event("input", { bubbles: true }));
      editor?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(editor?.value).toBe("Original description edited");
    expect(onDescriptionDirtyChange).toHaveBeenCalledWith(true);
  });
});
