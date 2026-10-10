// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SELECTION_DEBUG_STORAGE_KEY,
  initializeSelectionDebug,
  isSelectionDebugEnabled,
  recordAnnotationCommit,
  recordCaptureSelection,
  recordMarkdownMutations,
  recordSelectionChange,
} from "./document-annotation-debug";

describe("document annotation selection diagnostics", () => {
  afterEach(() => {
    window.localStorage.removeItem(SELECTION_DEBUG_STORAGE_KEY);
    delete window.__paperclipSelectionDebug;
    vi.restoreAllMocks();
  });

  it("stays disabled until the dev localStorage flag is enabled", () => {
    expect(isSelectionDebugEnabled()).toBe(false);

    window.localStorage.setItem(SELECTION_DEBUG_STORAGE_KEY, "true");

    expect(isSelectionDebugEnabled()).toBe(true);
  });

  it("records selection cadence, capture cost, commits, and idle markdown mutations", () => {
    window.localStorage.setItem(SELECTION_DEBUG_STORAGE_KEY, "1");
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const state = initializeSelectionDebug();

    recordSelectionChange(true);
    recordSelectionChange(false);
    recordCaptureSelection(12.5, true);
    recordAnnotationCommit("DocumentAnnotationLayer", "update", 4.25);
    expect(state.lastSelectionChangeAt).not.toBeNull();
    state.lastSelectionChangeAt = performance.now() - 200;
    recordMarkdownMutations(3);

    const snapshot = state.snapshot();
    expect(snapshot.selectionChanges).toBe(2);
    expect(snapshot.activeSelectionChanges).toBe(1);
    expect(snapshot.captureCount).toBe(1);
    expect(snapshot.captureDurationMs).toBe(12.5);
    expect(snapshot.maxCaptureDurationMs).toBe(12.5);
    expect(snapshot.reactCommits.DocumentAnnotationLayer).toBe(1);
    expect(snapshot.idleMutationCallbacks).toBe(1);
    expect(snapshot.idleMutationRecords).toBe(3);
  });
});
