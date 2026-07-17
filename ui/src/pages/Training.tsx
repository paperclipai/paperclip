import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DecisionTrainingExample, DecisionTrainingSourceKind, IssueComment, Project } from "@paperclipai/shared";
import { ArrowLeft, Download, Search } from "lucide-react";
import { useNavigate, useParams } from "@/lib/router";
import { decisionTrainingApi, type DecisionTrainingFilters } from "@/api/decisionTraining";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatDate, formatDateTime } from "@/lib/utils";

type SnapshotRecord = Record<string, unknown>;

function stringValue(record: SnapshotRecord | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function recordDate(record: SnapshotRecord) {
  const value = record.createdAt ?? record.created_at;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : "";
}

function recordId(record: SnapshotRecord) {
  return stringValue(record, "id") ?? "";
}

export function partitionTrainingThread(
  snapshotComments: SnapshotRecord[],
  liveComments: Array<SnapshotRecord | IssueComment>,
  cutoffAt: string,
) {
  const snapshotIds = new Set(snapshotComments.map(recordId).filter(Boolean));
  const cutoffMs = new Date(cutoffAt).getTime();
  const excluded = liveComments.filter((comment) => {
    if (snapshotIds.has(recordId(comment as SnapshotRecord))) return false;
    const createdMs = new Date(recordDate(comment as SnapshotRecord)).getTime();
    return Number.isNaN(createdMs) || createdMs > cutoffMs;
  });
  return { included: snapshotComments, excluded };
}

function decisionTitle(example: DecisionTrainingExample, issueTitle?: string) {
  const payload = example.snapshot.decision.payload;
  return stringValue(payload, "title", "prompt", "summary", "action") ?? issueTitle ?? "Decision training example";
}

function outcomeLabel(value: string | null) {
  if (!value) return "Pending at capture";
  return value.replaceAll("_", " ");
}

function authorLabel(id: string) {
  return id === "local-board" ? "Local board" : id.slice(0, 8);
}

function downloadExport(companyId: string) {
  const anchor = document.createElement("a");
  anchor.href = `/api/companies/${companyId}/decision-training/export.jsonl`;
  anchor.download = "decision-training.jsonl";
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function TrainingLibrary() {
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [q, setQ] = useState("");
  const [project, setProject] = useState("all");
  const [kind, setKind] = useState("all");
  const [author, setAuthor] = useState("all");

  useEffect(() => setBreadcrumbs([{ label: "Decisions", href: "/decisions" }, { label: "Training" }]), [setBreadcrumbs]);

  const filters = useMemo<DecisionTrainingFilters>(() => ({
    q: q.trim() || undefined,
    project: project === "all" ? undefined : project,
    kind: kind === "all" ? undefined : kind as DecisionTrainingSourceKind,
    author: author === "all" ? undefined : author,
  }), [author, kind, project, q]);
  const recordsQuery = useQuery({
    queryKey: [...queryKeys.decisionTraining.list(selectedCompanyId ?? ""), filters],
    queryFn: ({ signal }) => decisionTrainingApi.list(selectedCompanyId!, filters, { signal }),
    enabled: Boolean(selectedCompanyId),
  });
  const projectsQuery = useQuery({
    queryKey: ["projects", selectedCompanyId],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const records = recordsQuery.data ?? [];
  const projects = projectsQuery.data ?? [];
  const projectNames = new Map(projects.map((item: Project) => [item.id, item.name]));
  const authors = [...new Set(records.map((row) => row.example.createdByUserId))];

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-bold">Training examples</h1>
          <p className="mt-1 text-sm text-muted-foreground">Human decision traces with frozen state for future eval cases.</p>
        </div>
        <Button variant="outline" onClick={() => selectedCompanyId && downloadExport(selectedCompanyId)} disabled={!selectedCompanyId}>
          <Download className="size-4" /> Export JSONL
        </Button>
      </header>

      <div className="grid gap-3 md:grid-cols-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search training examples" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search notes, tasks…" className="pl-9" />
        </div>
        <Select value={project} onValueChange={setProject}><SelectTrigger aria-label="Filter by project"><SelectValue placeholder="Project: All" /></SelectTrigger><SelectContent><SelectItem value="all">Project: All</SelectItem>{projects.map((item: Project) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select>
        <Select value={kind} onValueChange={setKind}><SelectTrigger aria-label="Filter by decision kind"><SelectValue placeholder="Decision kind: All" /></SelectTrigger><SelectContent><SelectItem value="all">Decision kind: All</SelectItem><SelectItem value="interaction">Interaction</SelectItem><SelectItem value="approval">Approval</SelectItem><SelectItem value="execution_decision">Execution decision</SelectItem></SelectContent></Select>
        <Select value={author} onValueChange={setAuthor}><SelectTrigger aria-label="Filter by author"><SelectValue placeholder="Author: All" /></SelectTrigger><SelectContent><SelectItem value="all">Author: All</SelectItem>{authors.map((userId) => <SelectItem key={userId} value={userId}>{authorLabel(userId)}</SelectItem>)}</SelectContent></Select>
      </div>

      {recordsQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading training examples…</p> : null}
      {recordsQuery.isError ? <p className="text-sm text-destructive">Could not load training examples.</p> : null}
      {!recordsQuery.isLoading && !recordsQuery.isError && records.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">No training examples match these filters.</p> : null}

      <div className="overflow-hidden rounded-lg border border-border">
        <div className="hidden grid-cols-6 gap-4 bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
          <span>Decision</span><span>Outcome</span><span>Snapshot</span><span>Author</span><span>Created</span><span>Edited</span>
        </div>
        {records.map(({ example, issueIdentifier, issueTitle }) => {
          const issue = example.snapshot.issue;
          const projectName = projectNames.get(stringValue(issue, "projectId", "project_id") ?? "") ?? "No project";
          const edited = example.updatedAt !== example.createdAt;
          return (
            <button key={example.id} type="button" onClick={() => navigate(`/training/${example.id}`)} className="grid w-full gap-3 border-t border-border px-4 py-4 text-left transition-colors first:border-t-0 hover:bg-muted/30 md:grid-cols-6 md:items-center md:gap-4">
              <span className="min-w-0"><span className="block truncate text-sm font-medium">{decisionTitle(example, issueTitle)}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{issueIdentifier} · {projectName} · {example.sourceKind.replaceAll("_", " ")}</span></span>
              <span className="text-sm capitalize">{outcomeLabel(example.decisionOutcome)}</span>
              <span className="font-mono text-xs text-muted-foreground">{example.snapshot.cutoff.commentCount} comments · {example.snapshot.runs.length} runs · {example.snapshot.code.commitSha?.slice(0, 9) ?? "no repo"}</span>
              <span className="text-sm">{authorLabel(example.createdByUserId)}</span><span className="text-xs text-muted-foreground">{formatDate(example.createdAt)}</span><span className="text-xs text-muted-foreground">{edited ? formatDate(example.updatedAt) : "—"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function JsonPanel({ value }: { value: unknown }) {
  return <pre className="overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-4 font-mono text-xs leading-relaxed">{JSON.stringify(value, null, 2)}</pre>;
}

export function TrainingThreadPanel({ example, liveComments }: { example: DecisionTrainingExample; liveComments: IssueComment[] }) {
  const { included, excluded } = partitionTrainingThread(example.snapshot.comments, liveComments, example.cutoffAt);
  const renderComment = (comment: SnapshotRecord, ghosted = false) => (
    <div key={recordId(comment) || `${recordDate(comment)}-${stringValue(comment, "body")}`} data-excluded-from-snapshot={ghosted ? "true" : undefined} className={cn("py-4", ghosted && "opacity-50")}>
      <div className="font-mono text-xs text-muted-foreground">{stringValue(comment, "authorType", "author_type") ?? "Comment"} · {recordDate(comment) ? formatDateTime(recordDate(comment)) : "Unknown time"} · {recordId(comment).slice(0, 10)}</div>
      <p className="mt-2 whitespace-pre-wrap text-sm">{stringValue(comment, "body") ?? ""}</p>
      {ghosted ? <p className="mt-2 text-xs font-medium text-destructive">Excluded from snapshot · after cutoff</p> : null}
    </div>
  );
  return <div className="divide-y divide-border">{included.map((comment) => renderComment(comment))}<div data-training-cutoff className="flex items-center gap-3 py-4"><span className="h-px flex-1 bg-destructive" /><span className="font-mono text-xs font-bold text-destructive">CUTOFF · {formatDateTime(example.cutoffAt)}</span><span className="h-px flex-1 bg-destructive" /></div>{excluded.map((comment) => renderComment(comment as SnapshotRecord, true))}</div>;
}

export function TrainingInspector() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const [notes, setNotes] = useState("");
  const [editing, setEditing] = useState(false);
  const recordQuery = useQuery({ queryKey: queryKeys.decisionTraining.detail(id), queryFn: ({ signal }) => decisionTrainingApi.get(id, { signal }), enabled: Boolean(id) });
  const example = recordQuery.data;
  const commentsQuery = useQuery({ queryKey: ["issues", example?.issueId, "comments", "training-audit"], queryFn: () => issuesApi.listComments(example!.issueId, { order: "asc" }), enabled: Boolean(example?.issueId) });
  useEffect(() => {
    if (example && !editing) setNotes(example.notes);
  }, [editing, example]);
  useEffect(() => setBreadcrumbs([{ label: "Decisions", href: "/decisions" }, { label: "Training", href: "/training" }, { label: example ? decisionTitle(example) : "Example" }]), [example, setBreadcrumbs]);
  const saveMutation = useMutation({
    mutationFn: () => decisionTrainingApi.updateNotes(id, notes.trim()),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.decisionTraining.detail(id), updated);
      queryClient.invalidateQueries({ queryKey: queryKeys.decisionTraining.list(updated.companyId) });
      pushToast({ title: "Notes updated", tone: "success" });
      setEditing(false);
    },
    onError: (error) => {
      pushToast({
        title: "Could not update notes",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      });
    },
  });

  if (recordQuery.isLoading) return <p className="p-6 text-sm text-muted-foreground">Loading training example…</p>;
  if (recordQuery.isError) return <p className="p-6 text-sm text-destructive">Could not load training example.</p>;
  if (!example) return <p className="p-6 text-sm text-destructive">Training example not found.</p>;
  const issueIdentifier = stringValue(example.snapshot.issue, "identifier") ?? example.issueId.slice(0, 8);
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><Button variant="ghost" size="sm" className="mb-2 -ml-2" onClick={() => navigate("/training")}><ArrowLeft className="size-4" /> Training</Button><h1 className="truncate text-xl font-bold">{decisionTitle(example)}</h1><p className="mt-1 text-sm text-muted-foreground">{issueIdentifier} · {outcomeLabel(example.decisionOutcome)} · cutoff {formatDateTime(example.cutoffAt)}</p></div><Button variant="outline" onClick={() => downloadExport(example.companyId)}><Download className="size-4" /> Export JSONL</Button></header>
      <div className="grid gap-8 lg:grid-cols-2">
        <section><div className="mb-3 flex items-center justify-between"><div><h2 className="text-sm font-semibold">Training notes</h2><p className="mt-1 text-xs text-muted-foreground">Last edited {formatDateTime(example.updatedAt)} · edits are versioned</p></div>{!editing ? <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button> : null}</div>{editing ? <div className="space-y-3"><Textarea value={notes} onChange={(event) => setNotes(event.target.value)} className="min-h-72" /><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => { setNotes(example.notes); setEditing(false); }}>Cancel</Button><Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || notes.trim() === example.notes}>Save notes</Button></div></div> : <p className="whitespace-pre-wrap text-sm leading-relaxed">{example.notes || "No notes recorded."}</p>}</section>
        <section className="min-w-0"><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">Frozen state</h2><span className="font-mono text-xs text-muted-foreground">read-only</span></div><Tabs defaultValue="thread"><TabsList variant="line" className="w-full justify-start overflow-x-auto"><TabsTrigger value="thread">Thread</TabsTrigger><TabsTrigger value="issue">Issue</TabsTrigger><TabsTrigger value="runs">Runs</TabsTrigger><TabsTrigger value="code">Code</TabsTrigger><TabsTrigger value="decision">Decision</TabsTrigger></TabsList><TabsContent value="thread"><TrainingThreadPanel example={example} liveComments={commentsQuery.data ?? []} /></TabsContent><TabsContent value="issue"><JsonPanel value={example.snapshot.issue} /></TabsContent><TabsContent value="runs"><JsonPanel value={example.snapshot.runs} /></TabsContent><TabsContent value="code"><JsonPanel value={example.snapshot.code} /></TabsContent><TabsContent value="decision"><JsonPanel value={example.snapshot.decision} /></TabsContent></Tabs></section>
      </div>
    </div>
  );
}
