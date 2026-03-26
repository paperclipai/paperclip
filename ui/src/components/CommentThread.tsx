import { memo, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import type { IssueComment, Agent } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Check, Copy, Paperclip } from "lucide-react";
import { Identity } from "./Identity";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { StatusBadge } from "./StatusBadge";
import { AgentIcon } from "./AgentIconPicker";
import { formatDateTime } from "../lib/utils";
import { PluginSlotOutlet } from "@/plugins/slots";

export interface CommentWithRunMeta extends IssueComment {
  runId?: string | null;
  runAgentId?: string | null;
}

interface LinkedRunItem {
  runId: string;
  status: string;
  agentId: string;
  createdAt: Date | string;
  startedAt: Date | string | null;
}

interface CommentReassignment {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

interface CommentThreadProps {
  comments: CommentWithRunMeta[];
  linkedRuns?: LinkedRunItem[];
  companyId?: string | null;
  projectId?: string | null;
  onAdd: (body: string, reopen?: boolean, reassignment?: CommentReassignment) => Promise<void>;
  issueStatus?: string;
  agentMap?: Map<string, Agent>;
  imageUploadHandler?: (file: File) => Promise<string>;
  /** Callback to attach an image file to the parent issue (not inline in a comment). */
  onAttachImage?: (file: File) => Promise<void>;
  draftKey?: string;
  liveRunSlot?: React.ReactNode;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  submitLabel?: string;
  placeholder?: string;
  stickyInput?: boolean;
  hideReopen?: boolean;
  hideHeader?: boolean;
  /** Content shown when the timeline is empty. Pass null to suppress. Defaults to a text message. */
  emptyState?: React.ReactNode;
}

const DRAFT_DEBOUNCE_MS = 800;

function loadDraft(draftKey: string): string {
  try {
    return localStorage.getItem(draftKey) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(draftKey: string, value: string) {
  try {
    if (value.trim()) {
      localStorage.setItem(draftKey, value);
    } else {
      localStorage.removeItem(draftKey);
    }
  } catch {
    // Ignore localStorage failures.
  }
}

function clearDraft(draftKey: string) {
  try {
    localStorage.removeItem(draftKey);
  } catch {
    // Ignore localStorage failures.
  }
}

function parseReassignment(target: string): CommentReassignment | null {
  if (!target || target === "__none__") {
    return { assigneeAgentId: null, assigneeUserId: null };
  }
  if (target.startsWith("agent:")) {
    const assigneeAgentId = target.slice("agent:".length);
    return assigneeAgentId ? { assigneeAgentId, assigneeUserId: null } : null;
  }
  if (target.startsWith("user:")) {
    const assigneeUserId = target.slice("user:".length);
    return assigneeUserId ? { assigneeAgentId: null, assigneeUserId } : null;
  }
  return null;
}

function CopyMarkdownButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground transition-colors"
      title="Copy as markdown"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

type TimelineItem =
  | { kind: "comment"; id: string; createdAtMs: number; comment: CommentWithRunMeta }
  | { kind: "run"; id: string; createdAtMs: number; run: LinkedRunItem };

const DEFAULT_EMPTY_STATE = (
  <p className="text-sm text-muted-foreground">No comments or runs yet.</p>
);

const TimelineList = memo(function TimelineList({
  timeline,
  agentMap,
  companyId,
  projectId,
  highlightCommentId,
  emptyState = DEFAULT_EMPTY_STATE,
}: {
  timeline: TimelineItem[];
  agentMap?: Map<string, Agent>;
  companyId?: string | null;
  projectId?: string | null;
  highlightCommentId?: string | null;
  emptyState?: React.ReactNode;
}) {
  if (timeline.length === 0) {
    return emptyState ? <>{emptyState}</> : null;
  }

  return (
    <div className="space-y-3">
      {timeline.map((item) => {
        if (item.kind === "run") {
          const run = item.run;
          return (
            <div key={`run:${run.runId}`} className="border border-border bg-accent/20 p-3 overflow-hidden min-w-0 rounded-sm">
              <div className="flex items-center justify-between mb-2">
                <Link to={`/agents/${run.agentId}`} className="hover:underline">
                  <Identity
                    name={agentMap?.get(run.agentId)?.name ?? run.agentId.slice(0, 8)}
                    size="sm"
                  />
                </Link>
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(run.startedAt ?? run.createdAt)}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Run</span>
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <Link
                      to={`/agents/${run.agentId}/runs/${run.runId}`}
                      className="inline-flex items-center rounded-md border border-border bg-accent/40 px-2 py-1 font-mono text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
                    >
                      {run.runId.slice(0, 8)}
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    View full run transcript
                  </TooltipContent>
                </Tooltip>
                <StatusBadge status={run.status} />
              </div>
            </div>
          );
        }

        const comment = item.comment;
        const isHighlighted = highlightCommentId === comment.id;
        return (
          <div
            key={comment.id}
            id={`comment-${comment.id}`}
            className={`border p-3 overflow-hidden min-w-0 rounded-sm transition-colors duration-1000 ${isHighlighted ? "border-primary/50 bg-primary/5" : "border-border"}`}
          >
            <div className="flex items-center justify-between mb-1">
              {comment.authorAgentId ? (
                <Link to={`/agents/${comment.authorAgentId}`} className="hover:underline">
                  <Identity
                    name={agentMap?.get(comment.authorAgentId)?.name ?? comment.authorAgentId.slice(0, 8)}
                    size="sm"
                  />
                </Link>
              ) : (
                <Identity name="You" size="sm" />
              )}
              <span className="flex items-center gap-1.5">
                {companyId ? (
                  <PluginSlotOutlet
                    slotTypes={["commentContextMenuItem"]}
                    entityType="comment"
                    context={{
                      companyId,
                      projectId: projectId ?? null,
                      entityId: comment.id,
                      entityType: "comment",
                      parentEntityId: comment.issueId,
                    }}
                    className="flex flex-wrap items-center gap-1.5"
                    itemClassName="inline-flex"
                    missingBehavior="placeholder"
                  />
                ) : null}
                <a
                  href={`#comment-${comment.id}`}
                  className="text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors"
                >
                  {formatDateTime(comment.createdAt)}
                </a>
                <CopyMarkdownButton text={comment.body} />
              </span>
            </div>
            <MarkdownBody className="text-sm">{comment.body}</MarkdownBody>
            {companyId ? (
              <div className="mt-2 space-y-2">
                <PluginSlotOutlet
                  slotTypes={["commentAnnotation"]}
                  entityType="comment"
                  context={{
                    companyId,
                    projectId: projectId ?? null,
                    entityId: comment.id,
                    entityType: "comment",
                    parentEntityId: comment.issueId,
                  }}
                  className="space-y-2"
                  itemClassName="rounded-md"
                  missingBehavior="placeholder"
                />
              </div>
            ) : null}
            {comment.runId && (
              <div className="mt-2 pt-2 border-t border-border/60">
                {comment.runAgentId ? (
                  <Link
                    to={`/agents/${comment.runAgentId}/runs/${comment.runId}`}
                    className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                  >
                    run {comment.runId.slice(0, 8)}
                  </Link>
                ) : (
                  <span className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground">
                    run {comment.runId.slice(0, 8)}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

export function CommentThread({
  comments,
  linkedRuns = [],
  companyId,
  projectId,
  onAdd,
  agentMap,
  imageUploadHandler,
  onAttachImage,
  draftKey,
  liveRunSlot,
  enableReassign = false,
  reassignOptions = [],
  currentAssigneeValue = "",
  suggestedAssigneeValue,
  mentions: providedMentions,
  submitLabel,
  placeholder: placeholderProp,
  stickyInput = false,
  hideReopen = false,
  hideHeader = false,
  emptyState,
}: CommentThreadProps) {
  const [body, setBody] = useState("");
  const [reopen, setReopen] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const effectiveSuggestedAssigneeValue = suggestedAssigneeValue ?? currentAssigneeValue;
  const [reassignTarget, setReassignTarget] = useState(effectiveSuggestedAssigneeValue);
  const [highlightCommentId, setHighlightCommentId] = useState<string | null>(null);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const location = useLocation();
  const hasScrolledRef = useRef(false);

  const timeline = useMemo<TimelineItem[]>(() => {
    const commentItems: TimelineItem[] = comments.map((comment) => ({
      kind: "comment",
      id: comment.id,
      createdAtMs: new Date(comment.createdAt).getTime(),
      comment,
    }));
    const runItems: TimelineItem[] = linkedRuns.map((run) => ({
      kind: "run",
      id: run.runId,
      createdAtMs: new Date(run.startedAt ?? run.createdAt).getTime(),
      run,
    }));
    return [...commentItems, ...runItems].sort((a, b) => {
      if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
      if (a.kind === b.kind) return a.id.localeCompare(b.id);
      return a.kind === "comment" ? -1 : 1;
    });
  }, [comments, linkedRuns]);

  // Build mention options from agent map (exclude terminated agents)
  const mentions = useMemo<MentionOption[]>(() => {
    if (providedMentions) return providedMentions;
    if (!agentMap) return [];
    return Array.from(agentMap.values())
      .filter((a) => a.status !== "terminated")
      .map((a) => ({
        id: `agent:${a.id}`,
        name: a.name,
        kind: "agent",
        agentId: a.id,
        agentIcon: a.icon,
      }));
  }, [agentMap, providedMentions]);

  useEffect(() => {
    if (!draftKey) return;
    setBody(loadDraft(draftKey));
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveDraft(draftKey, body);
    }, DRAFT_DEBOUNCE_MS);
  }, [body, draftKey]);

  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  useEffect(() => {
    setReassignTarget(effectiveSuggestedAssigneeValue);
  }, [effectiveSuggestedAssigneeValue]);

  // Scroll to comment when URL hash matches #comment-{id}
  useEffect(() => {
    const hash = location.hash;
    if (!hash.startsWith("#comment-") || comments.length === 0) return;
    const commentId = hash.slice("#comment-".length);
    // Only scroll once per hash
    if (hasScrolledRef.current) return;
    const el = document.getElementById(`comment-${commentId}`);
    if (el) {
      hasScrolledRef.current = true;
      setHighlightCommentId(commentId);
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Clear highlight after animation
      const timer = setTimeout(() => setHighlightCommentId(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [location.hash, comments]);

  async function handleSubmit() {
    const trimmed = body.trim();
    if (!trimmed) return;
    const hasReassignment = enableReassign && reassignTarget !== currentAssigneeValue;
    const reassignment = hasReassignment ? parseReassignment(reassignTarget) : null;

    setSubmitting(true);
    try {
      await onAdd(trimmed, reopen ? true : undefined, reassignment ?? undefined);
      setBody("");
      if (draftKey) clearDraft(draftKey);
      setReopen(true);
      setReassignTarget(effectiveSuggestedAssigneeValue);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAttachFile(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    try {
      if (imageUploadHandler) {
        const url = await imageUploadHandler(file);
        const safeName = file.name.replace(/[[\]]/g, "\\$&");
        const markdown = `![${safeName}](${url})`;
        setBody((prev) => prev ? `${prev}\n\n${markdown}` : markdown);
      } else if (onAttachImage) {
        await onAttachImage(file);
      }
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  const canSubmit = !submitting && !!body.trim();

  return (
    <div className="space-y-4">
      {!hideHeader && <h3 className="text-sm font-semibold">Comments &amp; Runs ({timeline.length})</h3>}

      <TimelineList
        timeline={timeline}
        agentMap={agentMap}
        companyId={companyId}
        projectId={projectId}
        highlightCommentId={highlightCommentId}
        emptyState={emptyState}
      />

      {liveRunSlot}

      <div className={stickyInput ? "space-y-2 sticky bottom-0 bg-background pt-2 pb-1" : "space-y-2"}>
        <MarkdownEditor
          ref={editorRef}
          value={body}
          onChange={setBody}
          placeholder={placeholderProp ?? "Leave a comment..."}
          mentions={mentions}
          onSubmit={handleSubmit}
          imageUploadHandler={imageUploadHandler}
          contentClassName="min-h-[60px] text-sm"
        />
        <div className="flex items-center justify-end gap-3">
          {(imageUploadHandler || onAttachImage) && (
            <div className="mr-auto flex items-center gap-3">
              <input
                ref={attachInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={handleAttachFile}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => attachInputRef.current?.click()}
                disabled={attaching}
                title="Attach image"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </div>
          )}
          {!hideReopen && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={reopen}
                onChange={(e) => setReopen(e.target.checked)}
                className="rounded border-border"
              />
              Re-open
            </label>
          )}
          {enableReassign && reassignOptions.length > 0 && (
            <InlineEntitySelector
              value={reassignTarget}
              options={reassignOptions}
              placeholder="Assignee"
              noneLabel="No assignee"
              searchPlaceholder="Search assignees..."
              emptyMessage="No assignees found."
              onChange={setReassignTarget}
              className="text-xs h-8"
              renderTriggerValue={(option) => {
                if (!option) return <span className="text-muted-foreground">Assignee</span>;
                const agentId = option.id.startsWith("agent:") ? option.id.slice("agent:".length) : null;
                const agent = agentId ? agentMap?.get(agentId) : null;
                return (
                  <>
                    {agent ? (
                      <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : null}
                    <span className="truncate">{option.label}</span>
                  </>
                );
              }}
              renderOption={(option) => {
                if (!option.id) return <span className="truncate">{option.label}</span>;
                const agentId = option.id.startsWith("agent:") ? option.id.slice("agent:".length) : null;
                const agent = agentId ? agentMap?.get(agentId) : null;
                return (
                  <>
                    {agent ? (
                      <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : null}
                    <span className="truncate">{option.label}</span>
                  </>
                );
              }}
            />
          )}
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button size="sm" disabled={!canSubmit} onClick={handleSubmit}>
                {submitting ? "Posting..." : (submitLabel ?? "Comment")}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              Ctrl+Enter to send
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
