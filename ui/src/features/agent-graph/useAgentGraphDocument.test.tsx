// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentGraphDraft, AgentGraphLayout } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentGraphDocument } from "./useAgentGraphDocument";

const uiLayoutsApi = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), reset: vi.fn() }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "user-1" } }) } }));
vi.mock("@/api/uiLayouts", () => ({ uiLayoutsApi }));
vi.mock("../../api/uiLayouts", () => ({ uiLayoutsApi }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const draft: AgentGraphDraft = {
  id: "d1", x: 0, y: 0, name: "Copy", role: "engineer", title: null, capabilities: null,
  adapterType: "claude_local", model: null, reportsTo: null, sourceAgentId: null,
};
const sticky = { id: "s1", x: 0, y: 0, width: 200, height: 120, text: "", color: "yellow" as const };

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let doc: ReturnType<typeof useAgentGraphDocument>;

function Harness() {
  doc = useAgentGraphDocument("company-1");
  return null;
}

beforeEach(async () => {
  for (const fn of Object.values(uiLayoutsApi)) fn.mockReset();
  uiLayoutsApi.get.mockResolvedValue({ surface: "agent_graph", schemaVersion: null, layout: null, updatedAt: null });
  uiLayoutsApi.save.mockImplementation(async (_companyId: string, surface: string, layout: unknown) => ({
    surface, schemaVersion: 1, layout, updatedAt: null,
  }));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
});

function change(update: (layout: AgentGraphLayout) => AgentGraphLayout) {
  act(() => doc.apply(update));
}

function draftIds() {
  return doc.layout!.drafts.map((item) => item.id);
}

describe("agent graph history", () => {
  it("never brings a hired draft back through undo or redo", () => {
    change((layout) => ({ ...layout, stickies: [sticky] }));
    change((layout) => ({ ...layout, drafts: [draft] }));
    change((layout) => ({ ...layout, drafts: layout.drafts.map((item) => ({ ...item, x: 80, y: 80 })) }));
    change((layout) => ({ ...layout, direction: "LR" }));
    act(() => {
      doc.undo();
    });
    expect(draftIds()).toEqual(["d1"]);
    expect(doc.canRedo).toBe(true);

    act(() => doc.purgeDraft("d1"));
    expect(draftIds()).toEqual([]);

    const seen: string[][] = [];
    for (let i = 0; i < 6; i += 1) {
      act(() => {
        doc.redo();
      });
      seen.push(draftIds());
    }
    for (let i = 0; i < 6; i += 1) {
      act(() => {
        doc.undo();
      });
      seen.push(draftIds());
    }
    expect(seen.flat()).toEqual([]);
    expect(doc.layout!.stickies).toEqual([]);
    expect(doc.canUndo).toBe(false);
    act(() => {
      doc.redo();
    });
    expect(doc.layout!.stickies).toEqual([sticky]);
    act(() => {
      doc.redo();
    });
    expect(doc.layout).toMatchObject({ direction: "LR", drafts: [], stickies: [sticky] });
    expect(doc.canRedo).toBe(false);
  });

  it("leaves the history as it was when an undo or redo of a reporting line is cancelled", () => {
    change((layout) => ({ ...layout, stickies: [sticky] }));
    act(() => doc.recordReparent("agent-1", "manager-a", "manager-b"));
    const entry = { kind: "reparent", agentId: "agent-1", before: "manager-a", after: "manager-b" };

    let step: unknown;
    act(() => {
      step = doc.undo();
    });
    expect(step).toEqual(entry);
    expect(doc.canRedo).toBe(false);
    act(() => {
      step = doc.undo();
    });
    expect(step).toEqual(entry);
    expect(doc.layout!.stickies).toEqual([sticky]);

    act(() => doc.settleReparentStep("undo", "applied"));
    expect(doc.canRedo).toBe(true);
    act(() => {
      step = doc.redo();
    });
    expect(step).toEqual(entry);
    act(() => {
      step = doc.redo();
    });
    expect(step).toEqual(entry);
    expect(doc.canRedo).toBe(true);

    act(() => doc.settleReparentStep("redo", "applied"));
    expect(doc.canRedo).toBe(false);
    act(() => {
      step = doc.undo();
    });
    expect(step).toEqual(entry);
    act(() => doc.settleReparentStep("undo", "invalid"));
    expect(doc.canRedo).toBe(false);
    act(() => {
      step = doc.undo();
    });
    expect(step).toMatchObject({ kind: "document" });
    expect(doc.layout!.stickies).toEqual([]);
  });
});
