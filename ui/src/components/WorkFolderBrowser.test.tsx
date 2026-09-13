import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { WorkFolderSyncStatus } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkFolderBrowser } from "./WorkFolderBrowser";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { issuePrefix: "STG" } }) }));

const owner = { companyId: "company", scope: "task" as const, ownerId: "task" };
const key = ["work-folders", owner.companyId, owner.scope, owner.ownerId];
function render(statuses: WorkFolderSyncStatus[], lastOperationAt: string | null, readOnly = false, queryState?: "loading" | "error", filesState?: "loading" | "error") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData([...key, "files", false], { files: [], lastOperationAt });
  client.setQueryData([...key, "sync"], statuses);
  if (queryState === "loading") client.removeQueries({ queryKey: [...key, "sync"] });
  if (queryState === "error") client.getQueryCache().find({ queryKey: [...key, "sync"] })!
    .setState({ status: "error", error: new Error("Save service unavailable") });
  if (filesState === "loading") client.removeQueries({ queryKey: [...key, "files", false] });
  if (filesState === "error") client.getQueryCache().find({ queryKey: [...key, "files", false] })!
    .setState({ status: "error", error: new Error("File listing unavailable") });
  return renderToStaticMarkup(<MemoryRouter initialEntries={["/STG/issues/task"]}><QueryClientProvider client={client}><TooltipProvider><WorkFolderBrowser owner={owner} readOnly={readOnly} /></TooltipProvider></QueryClientProvider></MemoryRouter>);
}
const checkpoint: WorkFolderSyncStatus = { runId: "run", state: "saved", active: false,
  lastSavedAt: "2026-09-07T12:00:00.000Z", error: null, refreshRequested: false };

describe("work folder save feedback", () => {
  it("does not claim a save before the first checkpoint", () => {
    const pending = render([{ ...checkpoint, state: "starting", active: true, lastSavedAt: null }], null, true);
    expect(pending).toContain('role="status">Waiting for first save');
    expect(pending).not.toContain("Last agent save");
    expect(render([], null, true)).toContain('role="status">No saved files');
  });
  it("does not report success while save status is unknown", () => {
    expect(render([], null, true, "loading")).toContain('role="status">Loading save status…');
    const unavailable = render([checkpoint], null, true, "error");
    expect(unavailable).toContain('role="status">Save status unavailable');
    expect(unavailable).toContain("Last agent save");
    expect(unavailable).toContain("Save service unavailable");
  });
  it.each(["loading", "error"] as const)("preserves known save status while file listing is %s", (filesState) => {
    for (const [state, expected] of [["saved", "Saved"], ["saving", "Saving…"], ["failed", "Run save failed"]] as const) {
      const html = render([{ ...checkpoint, state }], null, true, undefined, filesState);
      expect(html).toContain(`role="status">${expected}`);
      expect(html).toContain("Last agent save");
      if (filesState === "error") {
        expect(html).toContain("File listing unavailable");
        expect(html).toContain("File list unavailable");
        expect(html).not.toContain("No files yet");
      }
    }
  });
  it("keeps inspection free of controls that mutate the cache or refresh the sandbox", () => {
    const html = render([checkpoint], null, true);
    for (const action of ["Upload", "Create folder", "Refresh sandbox", "Delete", "Restore", "Purge"]) expect(html).not.toContain(action);
    expect(html).toContain("Trash");
    expect(html).toContain("No cached files have been saved for this scope.");
  });
  it("labels direct file operations separately from agent checkpoints", () => {
    const html = render([checkpoint], "2026-09-07T12:01:00.000Z");
    expect(html).toContain('role="status">Saved');
    expect(html).toContain("Last agent save");
    expect(html).toContain("Files updated");
    const manualOnly = render([], "2026-09-07T12:01:00.000Z");
    expect(manualOnly).toContain("Files updated");
    expect(manualOnly).not.toContain("Last agent save");
  });
  it("keeps the last successful checkpoint visible during a failed or pending save", () => {
    const failed = render([{ ...checkpoint, state: "failed", error: "Working copy retained" }], null);
    expect(failed).toContain('role="status">Run save failed');
    expect(failed).toContain("Last agent save");
    expect(failed).toContain("Working copy retained");
    const saving = render([{ ...checkpoint, state: "saving", active: true }], null);
    expect(saving).toContain('role="status">Saving…');
    expect(saving).toContain("Last agent save");
  });
  it("identifies the failed run when a shared folder also has a newer successful save", () => {
    const html = render([checkpoint, { ...checkpoint, runId: "older-run", agentId: "other-agent", state: "failed",
      lastSavedAt: "2026-09-06T12:00:00.000Z", error: "Working copy retained" }], null, true);
    expect(html).toContain('role="status">Run save failed');
    expect(html).toContain("The files below are saved copies.");
    expect(html).toContain('href="/STG/agents/other-agent/runs/older-run"');
    expect(html).toContain("View failed run");
    expect(html).toContain("Last agent save");
  });
  it("keeps every failed sandbox accessible alongside saved shared files", () => {
    const html = render([checkpoint, ...["newer", "earlier"].map((runId) => ({
      ...checkpoint, runId, agentId: "other-agent", state: "failed" as const,
      error: `Retained ${runId} working copy`,
    }))], null, true);
    expect(html).toContain("2 sandbox runs could not save their files.");
    for (const runId of ["newer", "earlier"]) {
      expect(html).toContain(`href="/STG/agents/other-agent/runs/${runId}"`);
      expect(html).toContain(`Retained ${runId} working copy`);
    }
    expect(html).toContain("Last agent save");
  });

});
