import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkFolderSyncStatus } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkFolderBrowser } from "./WorkFolderBrowser";

const owner = { companyId: "company", scope: "task" as const, ownerId: "task" };
const key = ["work-folders", owner.companyId, owner.scope, owner.ownerId];
function render(statuses: WorkFolderSyncStatus[], lastOperationAt: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData([...key, "files", false], { files: [], lastOperationAt });
  client.setQueryData([...key, "sync"], statuses);
  return renderToStaticMarkup(<QueryClientProvider client={client}><TooltipProvider><WorkFolderBrowser owner={owner} /></TooltipProvider></QueryClientProvider>);
}
const checkpoint: WorkFolderSyncStatus = { runId: "run", state: "saved", active: false,
  lastSavedAt: "2026-09-07T12:00:00.000Z", error: null, refreshRequested: false };

describe("work folder save feedback", () => {
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
    expect(failed).toContain('role="status">Save failed');
    expect(failed).toContain("Last agent save");
    expect(failed).toContain("Working copy retained");
    const saving = render([{ ...checkpoint, state: "saving", active: true }], null);
    expect(saving).toContain('role="status">Saving…');
    expect(saving).toContain("Last agent save");
  });
});
