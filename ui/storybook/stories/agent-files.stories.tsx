import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentInstructionsFileDetail } from "@paperclipai/shared";
import { AgentFileRunNotice, PromptsTab } from "@/pages/AgentDetail";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { storybookAgents } from "../fixtures/paperclipData";

const agent = { ...storybookAgents[0]!, id: "agent-files-story", adapterType: "codex_local" as const };
const root = "/instance/agents/agent-files-story/instructions";
const originalInstructions = "# Agent instructions\n\nRead your notes in `notes/context.txt` before starting a task.\n\nKeep useful files in your agent directory for future tasks.\n";
const incomingInstructions = "# Agent instructions\n\nRead your notes before starting a task. Verify changes before handing them off.\n";
const noop = () => {};

const syncFailure = 'Agent file "large.bin" exceeds the 256 MiB per-file limit. This run\'s agent-folder changes were not saved; the temporary copy is discarded.';
const storageWarning = "Agent storage is full. The agent folder has reached its 2 GiB limit. Runs can continue; remove or shrink files in AGENT_HOME to free space. Changes exceeding the storage limits will not be saved.";

function AgentFilesStory({ failedSync = false, fullStorageRun = false, historicalFailures = false }: { failedSync?: boolean; fullStorageRun?: boolean; historicalFailures?: boolean }) {
  const client = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } }), []);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(0);
  const save = useRef<(() => void) | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const simulateAgent = useRef(noop);
  const onSave = useCallback((action: (() => void) | null) => { save.current = action; }, []);
  const onCancel = useCallback((action: (() => void) | null) => { cancel.current = action; }, []);

  useEffect(() => {
    let version = 0;
    const file = (path: string, content: string, binary = false): AgentInstructionsFileDetail => ({
      path, content, contentHash: `fixture-${++version}`, binary,
      size: binary ? 4 : new TextEncoder().encode(content).length,
      language: path.endsWith(".md") ? "markdown" : "text", markdown: path.endsWith(".md"),
      isEntryFile: path === "AGENTS.md", editable: !binary, deprecated: false, virtual: false,
    });
    const files = new Map([
      ["AGENTS.md", file("AGENTS.md", originalInstructions)],
      ["notes/context.txt", file("notes/context.txt", "Use short, concrete updates.\n")],
      ["cache.bin", file("cache.bin", "", true)],
    ]);
    const bundle = () => ({ agentId: agent.id, companyId: agent.companyId, persistence: "agent_files", mode: "managed",
      rootPath: root, managedRootPath: root, entryFile: "AGENTS.md", resolvedEntryPath: `${root}/AGENTS.md`, editable: true,
      warnings: [], legacyPromptTemplateActive: false, legacyBootstrapPromptTemplateActive: false,
      files: [...files.values()].map(({ content: _content, ...summary }) => summary),
    });
    simulateAgent.current = () => {
      files.set("AGENTS.md", file("AGENTS.md", incomingInstructions));
      client.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agent.id) });
      client.invalidateQueries({ queryKey: queryKeys.agents.instructionsFile(agent.id, "AGENTS.md") });
    };
    const originalFetch = window.fetch;
    const fixture: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      const base = `/api/agents/${agent.id}/instructions-bundle`;
      if (!url.pathname.startsWith(base)) return originalFetch(input, init);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const suffix = url.pathname.slice(base.length);
      const data = JSON.parse(String(init?.body ?? "{}"));
      if (suffix === "" && method === "GET") return Response.json(bundle());
      if (suffix === "/file") {
        const path = method === "PUT" ? data.path : url.searchParams.get("path")!;
        const current = files.get(path);
        if (method === "PUT" || method === "DELETE") {
          const baseHash = method === "PUT" ? data.baseHash : url.searchParams.get("baseHash");
          if (baseHash !== (current?.contentHash ?? null)) return Response.json({ error: "This file changed after you started editing. Compare the current file before saving again." }, { status: 409 });
          if (method === "DELETE") { files.delete(path); return Response.json({ ok: true }); }
          const next = file(path, data.content);
          files.set(path, next); setSaved(count => count + 1);
          return Response.json(next);
        }
        return current ? Response.json(current) : Response.json({ error: "File not found" }, { status: 404 });
      }
      if (suffix === "/candidates") return Response.json(historicalFailures ? [1, 2, 3].map(attempt => ({
        contract: "agent_files", runId: `failed-auth-${attempt}`, entryFile: "AGENTS.md", state: "unavailable", content: null, candidateHash: null,
        errorMessage: "The registered instruction copy could not be retrieved safely before environment release. No instruction save is claimed.",
      })) : []);
      return Response.json({ error: "This action is not included in this story." }, { status: 400 });
    };
    window.fetch = fixture; setReady(true);
    return () => { if (window.fetch === fixture) window.fetch = originalFetch; client.clear(); };
  }, [client, historicalFailures]);

  return <QueryClientProvider client={client}>
    <div className="space-y-6 p-6">
      <div className="space-y-3 rounded-md border border-border bg-muted p-4">
        <p className="text-sm">Storybook simulation · Real agent instructions editor with in-memory file responses. No provider runs or files on disk. Binary download is shown as a link only.</p>
        <Button variant="outline" onClick={() => simulateAgent.current()}>Simulate agent edit</Button>
        <p role="status" className="text-sm text-muted-foreground">{saved ? `${saved} file save completed in this story.` : "Saved agent files are ready for the next task."}</p>
      </div>
      {(failedSync || fullStorageRun) && <section aria-label="Affected run">
        <p className="text-sm font-medium">Affected run</p>
        <AgentFileRunNotice resultJson={{ instructionSave: { contract: "agent_files", state: failedSync ? "unavailable" : "saved",
          errorCode: failedSync ? "AGENT_FILES_LIMIT_EXCEEDED" : null,
          errorMessage: failedSync ? syncFailure : null, storageWarning: fullStorageRun ? storageWarning : null } }} />
      </section>}
      {ready && <PromptsTab agent={agent} companyId={agent.companyId} onDirtyChange={setDirty} onSavingChange={setSaving}
        onSaveActionChange={onSave} onCancelActionChange={onCancel} />}
      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" disabled={!dirty || saving} onClick={() => cancel.current?.()}>Cancel changes</Button>
        <Button disabled={!dirty || saving} onClick={() => save.current?.()}>Save changes</Button>
      </div>
    </div>
  </QueryClientProvider>;
}
const meta = { title: "Agents/Persistent files", component: AgentFilesStory, parameters: { layout: "fullscreen" } } satisfies Meta<typeof AgentFilesStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const InstructionsAndFiles: Story = {};
export const BrowserEdit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "edit" }));
    const editor = await canvas.findByRole("textbox");
    await userEvent.click(editor);
    await userEvent.type(editor, "Browser edits persist for future tasks. ");
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }));
    await expect(await canvas.findByText("1 file save completed in this story.")).toBeVisible();
    await waitFor(() => expect(canvas.getByRole("button", { name: "Save changes" })).toBeDisabled());
  },
};
export const AgentEditArrives: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "edit" });
    await userEvent.click(canvas.getByRole("button", { name: "Simulate agent edit" }));
    await expect(await canvas.findByText(/Verify changes before handing them off/)).toBeVisible();
  },
};
export const BinaryFile: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("cache.bin"));
    await expect(await canvas.findByRole("link", { name: "Download cache.bin" })).toBeVisible();
  },
};
export const LastSyncWins: Story = { ...AgentEditArrives };
export const StorageLimit: Story = {
  args: { failedSync: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("note")).toHaveTextContent("256 MiB per-file limit");
    await expect(canvas.queryByRole("button", { name: "Review preserved files" })).not.toBeInTheDocument();
  },
};

export const HistoricalFailuresAfterSuccessfulSave: Story = {
  args: { historicalFailures: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "edit" });
    await userEvent.click(canvas.getByRole("button", { name: "Simulate agent edit" }));
    await expect(await canvas.findByText(/Verify changes before handing them off/)).toBeVisible();
    await expect(canvas.queryByText("Agent file sync")).not.toBeInTheDocument();
    await expect(canvas.queryByText(/could not be retrieved safely/)).not.toBeInTheDocument();
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  },
};
export const StaleEditor: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "edit" }));
    await userEvent.type(await canvas.findByRole("textbox"), "Keep this unsaved draft. ");
    await userEvent.click(canvas.getByRole("button", { name: "Simulate agent edit" }));
    await userEvent.click(canvas.getByRole("button", { name: "Save changes" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Your unsaved edits are retained.");
    await expect(canvas.getByRole("textbox")).toHaveTextContent("Keep this unsaved draft.");
  },
};

export const FullStorageRunWarning: Story = {
  args: { fullStorageRun: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("note")).toHaveTextContent("Runs can continue");
    await expect(canvas.getByRole("note")).toHaveTextContent("2 GiB");
    await expect(await canvas.findByRole("button", { name: "edit" })).toBeEnabled();
  },
};
