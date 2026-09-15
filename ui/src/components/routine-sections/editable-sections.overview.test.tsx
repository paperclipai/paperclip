// @vitest-environment jsdom

import { useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewSection } from "./editable-sections";
import { OverviewSection as OverviewSectionProduction } from "./editable-sections.production";
import { RoutineDetailContext, type RoutineDetailContextValue, type RoutineEditDraft } from "./context";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Hoisted so the mock factory below (itself hoisted by vitest) can close over
// it. Asserting on this spy is what keeps the test from passing vacuously: if
// the mock's mount-only layout effect ever stopped firing (e.g. because the
// act/flushSync shim here stops flushing layout effects synchronously), the
// "not called with true" assertions below would trivially pass for the wrong
// reason — nothing happened at all — instead of because the fix gated a real
// mount-time onChange. Requiring this spy to have fired rules that out.
// `editorRenderSpy` records the props from every render of the mocked
// MarkdownEditor, so a test can grab the CURRENT onChange closure and invoke
// it directly — the same idiom AgentDetail.instructions.test.tsx uses to
// simulate the editor's internal onChange firing again independent of any
// DOM event (e.g. a subsequent mount-time-style normalization pass).
const { mountNormalizationSpy, editorRenderSpy } = vi.hoisted(() => ({
  mountNormalizationSpy: vi.fn(),
  editorRenderSpy: vi.fn(),
}));

// The real MarkdownEditor (MDXEditor) fires onChange once while it mounts,
// with the imported Markdown re-serialized/normalized, even with no user
// input. Mock it as a controlled <textarea> that reproduces exactly that: a
// mount-only layout effect calls onChange with a value DIFFERENT from its
// `value` prop (appending a trailing newline, like real normalization does),
// then it behaves like a normal controlled input for subsequent typing.
// Both `editable-sections.tsx` and `editable-sections.production.tsx` import
// `../MarkdownEditor` relative to this same directory, so one mock covers
// both variants under test below.
vi.mock("../MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => {
    editorRenderSpy({ value, onChange });
    const mountedRef = useRef(false);
    useLayoutEffect(() => {
      if (mountedRef.current) return;
      mountedRef.current = true;
      const normalized = `${value}\n`;
      mountNormalizationSpy(normalized);
      onChange(normalized);
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

// Passive effects (plain `useEffect`, unlike `useLayoutEffect`) are not
// guaranteed to flush synchronously inside `flushSync` in this harness —
// mirrors the `flushReact` helper in AgentDetail.instructions.test.tsx.
async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
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

function Harness({
  overviewSection: OverviewSectionComponent,
  onDescriptionDirtyChange,
  routineId = "routine-1",
  saveIsPending = false,
}: {
  overviewSection: ComponentType;
  onDescriptionDirtyChange: (dirty: boolean) => void;
  routineId?: string;
  saveIsPending?: boolean;
}) {
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
      id: routineId,
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
    saveRoutine: { isPending: saveIsPending, isSuccess: false, mutate: vi.fn() },
    saveConflict: false,
    isSectionDirty,
    navigateToSection: vi.fn(),
  } as unknown as RoutineDetailContextValue;

  return (
    <RoutineDetailContext.Provider value={value}>
      <OverviewSectionComponent />
    </RoutineDetailContext.Provider>
  );
}

describe.each([
  ["default variant", OverviewSection],
  ["production variant", OverviewSectionProduction],
] as const)("OverviewSection description editor (%s)", (_label, OverviewSectionComponent) => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    mountNormalizationSpy.mockClear();
    editorRenderSpy.mockClear();
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
      root?.render(
        <Harness overviewSection={OverviewSectionComponent} onDescriptionDirtyChange={onDescriptionDirtyChange} />,
      );
    });

    // The mocked editor's mount-only layout effect has already fired by now —
    // assert that for real, so a broken mock (or a shim that stops flushing
    // layout effects synchronously) can't make the assertions below pass
    // vacuously.
    expect(mountNormalizationSpy).toHaveBeenCalledTimes(1);
    expect(mountNormalizationSpy).toHaveBeenCalledWith("Original description\n");

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

  it("disarms the gate when a save starts, so a later spurious onChange is ignored", async () => {
    const onDescriptionDirtyChange = vi.fn();
    root = createRoot(container);
    const getEditor = () =>
      container.querySelector<HTMLTextAreaElement>('[data-testid="description-editor"]')!;

    act(() => {
      root?.render(
        <Harness
          overviewSection={OverviewSectionComponent}
          onDescriptionDirtyChange={onDescriptionDirtyChange}
          saveIsPending={false}
        />,
      );
    });
    await flushEffects();

    // A real interaction arms the gate and edits the description.
    act(() => {
      getEditor().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    });
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(getEditor(), "Edited by user");
      getEditor().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(getEditor().value).toBe("Edited by user");

    // Simulate the save STARTING (saveRoutine.isPending flips true as soon as
    // .mutate() is called — well before onSuccess's invalidations resolve).
    // This component instance is NOT guaranteed to unmount across a save
    // (the wrapping edit-mode toggle can stay on), so the reset must come
    // from OverviewSection's own effect watching saveRoutine.isPending.
    act(() => {
      root?.render(
        <Harness
          overviewSection={OverviewSectionComponent}
          onDescriptionDirtyChange={onDescriptionDirtyChange}
          saveIsPending={true}
        />,
      );
    });
    await flushEffects();

    // A subsequent onChange NOT preceded by a real interaction (e.g. the
    // editor's own normalization firing again off a props update once the
    // save's invalidated queries refetch) must be ignored now that the
    // save-start reset disarmed the gate.
    const latestOnChange = editorRenderSpy.mock.calls.at(-1)?.[0]?.onChange as (value: string) => void;
    act(() => {
      latestOnChange("Ghost normalization after save start");
    });

    expect(getEditor().value).toBe("Edited by user");
  });

  it("disarms the gate when the edited routine changes", async () => {
    const onDescriptionDirtyChange = vi.fn();
    root = createRoot(container);
    const getEditor = () =>
      container.querySelector<HTMLTextAreaElement>('[data-testid="description-editor"]')!;

    act(() => {
      root?.render(
        <Harness
          overviewSection={OverviewSectionComponent}
          onDescriptionDirtyChange={onDescriptionDirtyChange}
          routineId="routine-1"
        />,
      );
    });
    await flushEffects();

    act(() => {
      getEditor().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    });
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(getEditor(), "Edited on routine one");
      getEditor().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(getEditor().value).toBe("Edited on routine one");

    // Switch to a different routine while still on this component instance
    // (it is NOT guaranteed to unmount across a routine-to-routine
    // navigation — that's the bug this effect guards against).
    act(() => {
      root?.render(
        <Harness
          overviewSection={OverviewSectionComponent}
          onDescriptionDirtyChange={onDescriptionDirtyChange}
          routineId="routine-2"
        />,
      );
    });
    await flushEffects();

    const latestOnChange = editorRenderSpy.mock.calls.at(-1)?.[0]?.onChange as (value: string) => void;
    act(() => {
      latestOnChange("Ghost normalization for a different routine");
    });

    // The phantom onChange must be ignored: the routine-id change disarmed
    // the gate, and there has been no real interaction since, so the
    // description must still read the last value a real interaction wrote.
    expect(getEditor().value).toBe("Edited on routine one");
  });
});
