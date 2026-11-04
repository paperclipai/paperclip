import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { IssueDocument } from "@paperclipai/shared";
import { ArtifactUploadArea, type ArtifactUploadEntry } from "@/components/artifacts/ArtifactUploadArea";
import { IssuePropertiesArtifactsTab } from "@/components/issue-properties/IssuePropertiesArtifactsTab";
import { TaskDocumentPanel } from "@/components/task-side-panel/TaskDocumentPanel";
import { SidePanelFrame } from "@/components/side-panel/SidePanelFrame";
import { SidePanelTabs } from "@/components/side-panel/SidePanelTabs";
import { SidePanelMobileTabs } from "@/components/side-panel/SidePanelMobileTabs";
import type { SidePanelTabItem } from "@/components/side-panel/types";
import { queryKeys } from "@/lib/queryKeys";
import { useSidebar } from "@/context/SidebarContext";
import { addPreviewFile, createPreviewClient, installPreviewApi, issue, type PreviewState } from "./fixtures";

export function UploadPreview({ state = "empty" }: { state?: PreviewState }) {
  const [client] = useState(() => createPreviewClient(state));
  const [entries, setEntries] = useState<ArtifactUploadEntry[]>(() => state === "error" ? [{ id: "failed-upload", filename: "remaining-work.csv", status: "error", error: "Connection lost. Your file hasn’t been added." }] : state === "uploading" ? [{ id: "pending-upload", filename: "remaining-work.csv", status: "uploading" }] : []);
  const files = useRef(new Map<string, File>());
  const alive = useRef(true);
  const [announcement, setAnnouncement] = useState("");
  const [tabs, setTabs] = useState<SidePanelTabItem[]>([{ id: "artifacts", type: "view", label: "Artifacts", closable: false }]);
  const [activeTab, setActiveTab] = useState("artifacts");
  const [selectedDocuments, setSelectedDocuments] = useState<Record<string, IssueDocument>>({});
  const { isMobile: mobile } = useSidebar();
  const docQuery = useQuery({ queryKey: [...queryKeys.issues.documents(issue.id), "list"], queryFn: async () => [] as IssueDocument[], initialData: client.getQueryData<IssueDocument[]>([...queryKeys.issues.documents(issue.id), "list"]), staleTime: Infinity }, client);
  const productQuery = useQuery({ queryKey: queryKeys.issues.workProducts(issue.id), queryFn: async () => [], initialData: client.getQueryData(queryKeys.issues.workProducts(issue.id)), staleTime: Infinity }, client);

  useLayoutEffect(() => {
    alive.current = true;
    files.current.set("failed-upload", new File(["path,pattern\ndelivery,event-driven\nroutines,clock-driven"], "remaining-work.csv", { type: "text/csv" }));
    const restore = installPreviewApi(client);
    return () => { alive.current = false; restore(); };
  }, [client]);

  async function upload(batch: { id: string; file: File }[]) {
    for (const { id, file } of batch) {
      files.current.set(id, file);
      setEntries(current => [...current.filter(entry => entry.id !== id), { id, filename: file.name, status: "uploading" }]);
    }
    await Promise.all(batch.map(async ({ id, file }) => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!alive.current) return;
      try {
        await addPreviewFile(client, file, id);
        setEntries(current => current.filter(entry => entry.id !== id));
        setAnnouncement(`${file.name} added to this task.`);
        files.current.delete(id);
      } catch {
        setEntries(current => current.map(entry => entry.id === id ? { ...entry, status: "error", error: "This file couldn’t be read. Try again." } : entry));
      }
    }));
  }

  function openDocument(document: IssueDocument) {
    setSelectedDocuments(current => ({ ...current, [document.key]: document }));
    setTabs(current => current.some(tab => tab.id === document.key) ? current : [...current, { id: document.key, type: "document", label: document.title ?? document.key, closable: true }]);
    setActiveTab(document.key);
  }

  function closeTab(id: string) {
    if (id === "artifacts") return;
    setTabs(current => current.filter(tab => tab.id !== id));
    if (activeTab === id) setActiveTab("artifacts");
  }

  function handlePreviewLink(event: MouseEvent) {
    const link = (event.target as HTMLElement).closest("a");
    if (!link) return;
    const url = new URL(link.href, window.location.origin);
    const key = url.searchParams.get("doc");
    if (key) {
      const document = docQuery.data?.find(doc => doc.key === key);
      if (document) { event.preventDefault(); openDocument(document); }
      return;
    }
    const attachmentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)\/content$/);
    const file = attachmentMatch && client.getQueryData<File>(["storybook-upload-file", attachmentMatch[1]]);
    if (!file) return;
    event.preventDefault();
    // Browser navigations bypass the in-memory fetch fixture. Supply the
    // preview's bytes locally for the production card's open/download links.
    const href = URL.createObjectURL(file);
    if (url.searchParams.has("download")) {
      const download = window.document.createElement("a");
      download.href = href;
      download.download = file.name;
      download.click();
    } else window.open(href, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
  }

  const tabProps = { tabs, activeTabId: activeTab, onActiveTabChange: setActiveTab, onCloseTab: closeTab };
  const header = mobile ? <SidePanelMobileTabs {...tabProps} /> : <SidePanelTabs {...tabProps} appearance="streamlined-task" />;
  return <QueryClientProvider client={client}>
    <div className="h-full min-h-0" onClickCapture={handlePreviewLink}>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
      {activeTab === "artifacts" ? <ArtifactUploadArea header={header} empty={!(docQuery.data?.length || (productQuery.data as unknown[] | undefined)?.length)} entries={entries}
        onUpload={picked => void upload(picked.map(file => ({ id: crypto.randomUUID(), file })))}
        onRetry={id => { const file = files.current.get(id); if (file) void upload([{ id, file }]); }}
        onDismiss={id => { files.current.delete(id); setEntries(current => current.filter(entry => entry.id !== id)); }}>
        <IssuePropertiesArtifactsTab issue={issue} onOpenDocument={openDocument} />
      </ArtifactUploadArea> : <SidePanelFrame presentation="sheet" label="Task document" header={header}><TaskDocumentPanel issueId={issue.id} documentKey={activeTab} initialDocument={selectedDocuments[activeTab]} /></SidePanelFrame>}
    </div>
  </QueryClientProvider>;
}
