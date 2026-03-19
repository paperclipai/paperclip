// @vitest-environment node

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildIssueDraftStorageKey,
  clearIssueDraft,
  ISSUE_DRAFT_DEBOUNCE_MS,
  loadIssueDraft,
  saveIssueDraft,
  type StoredIssueDraft,
} from "./issue-draft";

const storage = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
  },
  configurable: true,
});

const draft: StoredIssueDraft = {
  title: "Ship board fix",
  description: "Keep work company-scoped.",
  status: "todo",
  priority: "medium",
  assigneeValue: "agent:agent-1",
  projectId: "project-1",
  assigneeModelOverride: "",
  assigneeThinkingEffort: "",
  assigneeChrome: false,
  useIsolatedExecutionWorkspace: false,
};

describe("issue draft helpers", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("builds company-scoped storage keys", () => {
    expect(buildIssueDraftStorageKey("company-1")).toBe("paperclip:issue-draft:company:company-1");
  });

  it("stores drafts under the active company", () => {
    saveIssueDraft("company-1", draft);

    expect(loadIssueDraft("company-1")).toEqual(draft);
    expect(loadIssueDraft("company-2")).toBeNull();
  });

  it("falls back to the legacy global key for migration", () => {
    localStorage.setItem("paperclip:issue-draft", JSON.stringify(draft));

    expect(loadIssueDraft("company-1")).toEqual(draft);
  });

  it("clears both scoped and legacy keys once a company-scoped draft is reset", () => {
    localStorage.setItem("paperclip:issue-draft", JSON.stringify(draft));
    saveIssueDraft("company-1", draft);

    clearIssueDraft("company-1");

    expect(loadIssueDraft("company-1")).toBeNull();
    expect(localStorage.getItem("paperclip:issue-draft")).toBeNull();
  });

  it("keeps the new issue draft debounce aligned with other draft surfaces", () => {
    expect(ISSUE_DRAFT_DEBOUNCE_MS).toBe(800);
  });
});
