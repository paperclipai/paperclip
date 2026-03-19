// @vitest-environment node

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildRecentAssigneeStorageKey,
  getRecentAssigneeIds,
  sortAgentsByRecency,
  trackRecentAssignee,
} from "./recent-assignees";

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

describe("recent assignee helpers", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("builds company-scoped storage keys", () => {
    expect(buildRecentAssigneeStorageKey("company-1")).toBe("paperclip:recent-assignees:company:company-1");
  });

  it("tracks assignees independently per company", () => {
    trackRecentAssignee("agent-1", "company-1");
    trackRecentAssignee("agent-2", "company-2");

    expect(getRecentAssigneeIds("company-1")).toEqual(["agent-1"]);
    expect(getRecentAssigneeIds("company-2")).toEqual(["agent-2"]);
  });

  it("falls back to the legacy global list until scoped data exists", () => {
    localStorage.setItem("paperclip:recent-assignees", JSON.stringify(["legacy-agent"]));

    expect(getRecentAssigneeIds("company-1")).toEqual(["legacy-agent"]);
  });

  it("orders recent assignees before alphabetical fallback", () => {
    const sorted = sortAgentsByRecency(
      [
        { id: "agent-2", name: "Bravo" },
        { id: "agent-1", name: "Alpha" },
        { id: "agent-3", name: "Charlie" },
      ],
      ["agent-3", "agent-2"],
    );

    expect(sorted.map((agent) => agent.id)).toEqual(["agent-3", "agent-2", "agent-1"]);
  });
});
