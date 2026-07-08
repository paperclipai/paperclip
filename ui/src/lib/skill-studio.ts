import type {
  CompanySkillLastEditor,
  CompanySkillListItem,
  CompanySkillTestInput,
  CompanySkillTestRun,
  CompanySkillTestRunCreateRequest,
  CompanySkillTestRunDetail,
  CompanySkillTestRunHarnessContentUnavailableReason,
  CompanySkillTestRunStatus,
  CompanySkillTestRunTemplate,
  IssueAttachment,
  IssueDocument,
} from "@paperclipai/shared";
import {
  getIssueOutputs,
  getPromotedOutputAttachmentIds,
  isImageContentType,
  isVideoLikeOutput,
} from "./issue-output";

/**
 * Pure logic for the Skill Studio UI (PAP-12962). Kept free of React so the
 * three behavioural contracts the acceptance criteria call out — run-status
 * derivation, the disabled-Run matrix, and interaction inline-vs-fallback
 * routing — are unit-testable in isolation.
 */

export const TERMINAL_RUN_STATUSES: readonly CompanySkillTestRunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
];

export const DEFAULT_TEST_RUN_TEMPLATE_ID = "built-in:default-test-template";
export const NO_TEST_RUN_TEMPLATE_STORAGE_VALUE = "__paperclip_no_template__";

export function isTerminalRunStatus(status: CompanySkillTestRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** V1 poll policy: poll every 2s while a run is non-terminal, stop on terminal. */
export function shouldPollRun(status: CompanySkillTestRunStatus): boolean {
  return !isTerminalRunStatus(status);
}

/**
 * Map a test-run status onto the shared `StatusBadge` status vocabulary so the
 * Studio never invents a bespoke chip (spec D6). `queued` aligns with the
 * pending/yellow treatment.
 */
export type RunBadgeStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export function runBadgeStatus(status: CompanySkillTestRunStatus): RunBadgeStatus {
  return status;
}

/**
 * What the right-pane output region should render for a run.
 * - `output`      — a completed run with output body.
 * - `draft`       — a failed/cancelled run that still produced partial output
 *                   ("draft at failure").
 * - `pending`     — non-terminal run, output not ready yet.
 * - `none`        — terminal run with no output at all.
 */
export type RunOutputMode = "output" | "draft" | "pending" | "none";

export function runOutputMode(run: {
  status: CompanySkillTestRunStatus;
  outputBody?: string | null;
}): RunOutputMode {
  const hasOutput = Boolean(run.outputBody && run.outputBody.trim().length > 0);
  if (!isTerminalRunStatus(run.status)) {
    return hasOutput ? "output" : "pending";
  }
  if (run.status === "succeeded") {
    return hasOutput ? "output" : "none";
  }
  // failed / cancelled
  return hasOutput ? "draft" : "none";
}

/** Failed runs get an error card at the top of the detail view; cancelled do not. */
export function showRunErrorCard(status: CompanySkillTestRunStatus): boolean {
  return status === "failed";
}

/**
 * Whether the "Open test task ↗" deep link is live. A retention-expired or
 * hard-deleted harness issue leaves the run row intact (self-contained
 * snapshots) but disables the link with a "Test task expired" tooltip.
 */
export function testTaskLinkState(run: {
  taskExpired: boolean;
  harnessIssue?: { id: string } | null;
}): { enabled: boolean; reason: string | null } {
  if (run.taskExpired || !run.harnessIssue) {
    return { enabled: false, reason: "Test task expired" };
  }
  return { enabled: true, reason: null };
}

// ---------------------------------------------------------------------------
// Disabled-Run matrix (contract §7.1 "Buttons")
// ---------------------------------------------------------------------------

export interface RunGateInput {
  /** An agent is selected in the picker (paused agents are never selectable). */
  hasAgent: boolean;
  /** The active input (saved or ad-hoc paste) has non-whitespace content. */
  hasInput: boolean;
  /** Number of files in the skill under test. */
  skillFileCount: number;
  /** A run is already in flight from this surface (optional guard). */
  runInFlight?: boolean;
  /** The editor has unsaved content that is not yet on disk or in a version. */
  hasUnsavedSkillEdits?: boolean;
}

export interface RunGateResult {
  disabled: boolean;
  /** Tooltip copy naming the reason, or null when the Run button is enabled. */
  reason: string | null;
}

/**
 * Evaluate the Run button's disabled state. Reasons are checked in priority
 * order and the first blocking condition wins, so the tooltip always names a
 * single actionable reason (recognition over recall).
 */
export function evaluateRunGate(input: RunGateInput): RunGateResult {
  if (input.skillFileCount <= 0) {
    return { disabled: true, reason: "This skill has no files to test" };
  }
  if (!input.hasAgent) {
    return { disabled: true, reason: "Pick an agent to run" };
  }
  if (!input.hasInput) {
    return { disabled: true, reason: "Add or paste input text to run" };
  }
  if (input.hasUnsavedSkillEdits) {
    return { disabled: true, reason: "Save skill edits before running" };
  }
  if (input.runInFlight) {
    return { disabled: true, reason: "A run is already in progress" };
  }
  return { disabled: false, reason: null };
}

// ---------------------------------------------------------------------------
// Saved input editor state
// ---------------------------------------------------------------------------

export interface SavedInputDraftState {
  inputId: string | null;
  draft: string;
  baselineContent: string;
}

export const EMPTY_SAVED_INPUT_DRAFT_STATE: SavedInputDraftState = {
  inputId: null,
  draft: "",
  baselineContent: "",
};

/**
 * Keep the saved-input editor synchronized with the selected input record while
 * preserving local dirty edits across background refetches. This covers the
 * deep-link case where `selectedInputId` is already set before the input rows
 * arrive, and the normal switch-input case where the selected row changes.
 */
export function syncSavedInputDraftState(
  previous: SavedInputDraftState,
  selectedInput: Pick<CompanySkillTestInput, "id" | "content"> | null,
): SavedInputDraftState {
  if (!selectedInput) {
    return previous.inputId === null
      ? previous
      : EMPTY_SAVED_INPUT_DRAFT_STATE;
  }

  if (previous.inputId !== selectedInput.id) {
    return {
      inputId: selectedInput.id,
      draft: selectedInput.content,
      baselineContent: selectedInput.content,
    };
  }

  if (previous.baselineContent === selectedInput.content) {
    return previous;
  }

  if (previous.draft === previous.baselineContent) {
    return {
      inputId: selectedInput.id,
      draft: selectedInput.content,
      baselineContent: selectedInput.content,
    };
  }

  return previous;
}

export function selectedSavedInputDraft(
  state: SavedInputDraftState,
  selectedInput: Pick<CompanySkillTestInput, "id" | "content"> | null,
): string {
  if (!selectedInput) return "";
  return state.inputId === selectedInput.id ? state.draft : selectedInput.content;
}

export function savedInputDraftDirty(
  state: SavedInputDraftState,
  selectedInput: Pick<CompanySkillTestInput, "id" | "content"> | null,
): boolean {
  return Boolean(
    selectedInput
    && state.inputId === selectedInput.id
    && state.draft !== selectedInput.content,
  );
}

// ---------------------------------------------------------------------------
// Interaction inline-vs-fallback routing (board 12)
// ---------------------------------------------------------------------------

/**
 * Interaction kinds that render as inline, answerable cards inside the Studio.
 * Answering posts to the real interaction on the hidden harness task; every
 * other kind is shown as a non-dropped summary row that links out to the task.
 */
export const INLINE_INTERACTION_KINDS: ReadonlySet<string> = new Set([
  "ask_user_questions",
  "request_confirmation",
]);

export type InteractionRendering = "inline" | "fallback";

export function routeInteraction(kind: string): InteractionRendering {
  return INLINE_INTERACTION_KINDS.has(kind) ? "inline" : "fallback";
}

/** An interaction is answerable inline only while it is still pending. */
export function isInteractionAnswerable(interaction: { kind: string; status: string }): boolean {
  return routeInteraction(interaction.kind) === "inline" && interaction.status === "pending";
}

// ---------------------------------------------------------------------------
// Agent picker helpers
// ---------------------------------------------------------------------------

export interface AgentPickerItem {
  id: string;
  status: string;
}

/** Paused agents are muted and unselectable in the picker. */
export function isAgentSelectable(agent: { status: string }): boolean {
  return agent.status !== "paused";
}

// ---------------------------------------------------------------------------
// Run label helpers
// ---------------------------------------------------------------------------

/**
 * Short, stable run identifier for history rows (`#` + first 7 of the id),
 * mirroring how the run detail header labels a run.
 */
export function runShortId(run: Pick<CompanySkillTestRun, "id">): string {
  return `#${run.id.replace(/-/g, "").slice(0, 7)}`;
}

export function isRunActive(run: Pick<CompanySkillTestRun, "status">): boolean {
  return !isTerminalRunStatus(run.status);
}

// ---------------------------------------------------------------------------
// Advanced run template helpers
// ---------------------------------------------------------------------------

export type RunTemplateSelection = string | null;

export interface RunTemplateSelectionResolution {
  selection: RunTemplateSelection;
  template: CompanySkillTestRunTemplate | null;
  recovered: boolean;
}

export function serializeRunTemplateSelection(selection: RunTemplateSelection): string {
  return selection === null ? NO_TEST_RUN_TEMPLATE_STORAGE_VALUE : selection;
}

export function parseRunTemplateSelection(value: string | null): RunTemplateSelection {
  if (value === NO_TEST_RUN_TEMPLATE_STORAGE_VALUE) return null;
  return value && value.trim() ? value : DEFAULT_TEST_RUN_TEMPLATE_ID;
}

export function resolveRunTemplateSelection(
  selection: RunTemplateSelection,
  templates: readonly CompanySkillTestRunTemplate[],
): RunTemplateSelectionResolution {
  if (selection === null) {
    return { selection: null, template: null, recovered: false };
  }

  const template = templates.find((candidate) => candidate.id === selection) ?? null;
  if (template) {
    return { selection, template, recovered: false };
  }

  const fallback =
    templates.find((candidate) => candidate.id === DEFAULT_TEST_RUN_TEMPLATE_ID)
    ?? templates[0]
    ?? null;

  return {
    selection: fallback?.id ?? null,
    template: fallback,
    recovered: true,
  };
}

export function buildCreateRunRequest(input: {
  agentId: string;
  inputId: string | null;
  content: string | null;
  templateId: RunTemplateSelection;
}): CompanySkillTestRunCreateRequest {
  return {
    agentId: input.agentId,
    inputId: input.inputId,
    content: input.content,
    templateId: input.templateId,
  };
}

/** The output document, if the run detail carries one under its output key. */
export function findOutputDocument(detail: Pick<CompanySkillTestRunDetail, "documents" | "outputDocumentKey">) {
  return detail.documents.find((doc) => doc.key === detail.outputDocumentKey) ?? null;
}

type RunRichOutputDetail = Pick<CompanySkillTestRunDetail, "outputDocumentKey" | "harnessContent">;

export interface RunHarnessUnavailableCopy {
  title: string;
  body: string;
}

export interface RunMediaGalleryItem {
  id: string;
  contentPath: string;
  openPath?: string;
  downloadPath?: string;
  contentType: string;
  originalFilename: string | null;
}

function runHarnessUnavailableTitle(reason: CompanySkillTestRunHarnessContentUnavailableReason | null) {
  if (reason === "expired") return "Test task expired";
  if (reason === "deleted") return "Test task deleted";
  return "Test task unavailable";
}

export function runHarnessUnavailableCopy(
  detail: Pick<CompanySkillTestRunDetail, "harnessContent">,
): RunHarnessUnavailableCopy | null {
  if (detail.harnessContent.available) return null;
  return {
    title: runHarnessUnavailableTitle(detail.harnessContent.unavailableReason),
    body: "Stored run snapshots are still shown. Harness documents, attachments, and work products are no longer available.",
  };
}

export function findRunOutputDocument(detail: RunRichOutputDetail): IssueDocument | null {
  return detail.harnessContent.documents.find((doc) => doc.key === detail.outputDocumentKey) ?? null;
}

export function getRunAdditionalDocuments(detail: RunRichOutputDetail): IssueDocument[] {
  const outputDocument = findRunOutputDocument(detail);
  return detail.harnessContent.documents.filter((doc) => {
    if (doc.key === detail.outputDocumentKey) return false;
    if (outputDocument && doc.id === outputDocument.id) return false;
    return true;
  });
}

export function getRunRawAttachments(detail: RunRichOutputDetail): IssueAttachment[] {
  const promotedOutputAttachmentIds = getPromotedOutputAttachmentIds(detail.harnessContent.workProducts);
  return detail.harnessContent.attachments.filter((attachment) => !promotedOutputAttachmentIds.has(attachment.id));
}

export function getRunMediaGalleryItems(detail: RunRichOutputDetail): RunMediaGalleryItem[] {
  const items: RunMediaGalleryItem[] = [];
  const seen = new Set<string>();

  const mark = (attachmentId: string | null | undefined, contentPath: string) => {
    if (attachmentId) seen.add(`attachment:${attachmentId}`);
    seen.add(`content:${contentPath}`);
  };
  const hasSeen = (attachmentId: string | null | undefined, contentPath: string) => (
    Boolean(attachmentId && seen.has(`attachment:${attachmentId}`)) ||
    seen.has(`content:${contentPath}`)
  );

  for (const attachment of detail.harnessContent.attachments) {
    if (
      !isImageContentType(attachment.contentType) &&
      !isVideoLikeOutput(attachment.contentType, attachment.originalFilename)
    ) {
      continue;
    }
    items.push(attachment);
    mark(attachment.id, attachment.contentPath);
  }

  for (const output of getIssueOutputs(detail.harnessContent.workProducts).items) {
    const meta = output.metadata;
    if (!meta) continue;
    const isMedia = isImageContentType(meta.contentType) ||
      isVideoLikeOutput(meta.contentType, meta.originalFilename);
    if (!isMedia || hasSeen(meta.attachmentId, meta.contentPath)) continue;
    items.push({
      id: `work-product-${output.id}`,
      contentPath: meta.contentPath,
      openPath: meta.openPath,
      downloadPath: meta.downloadPath,
      contentType: meta.contentType,
      originalFilename: meta.originalFilename ?? output.title,
    });
    mark(meta.attachmentId, meta.contentPath);
  }

  return items;
}

/**
 * Build the create-run request for a Re-run of an existing run. Re-run must
 * reproduce the VIEWED run's snapshots — its agent, its input (saved input by
 * id, or the ad-hoc snapshot as literal content), and its pinned skill version
 * — rather than whatever the picker holds this session. Reading these off the
 * run detail is the fix for the Bug A regression that posted `agentId: null`
 * from empty picker state (PAP-13001).
 */
export function buildReRunRequest(
  detail: Pick<
    CompanySkillTestRun,
    "agentId"
    | "inputId"
    | "inputSnapshot"
    | "skillVersionId"
    | "templateId"
    | "templateName"
    | "templateBody"
  >,
): CompanySkillTestRunCreateRequest {
  return {
    agentId: detail.agentId,
    inputId: detail.inputId ?? undefined,
    content: detail.inputId ? undefined : detail.inputSnapshot,
    skillVersionId: detail.skillVersionId,
    templateSnapshot: {
      templateId: detail.templateId,
      templateName: detail.templateName,
      templateBody: detail.templateBody,
    },
  };
}

// ---------------------------------------------------------------------------
// Studio landing — recently visited + recently updated (PAP-13150)
// ---------------------------------------------------------------------------

export const RECENT_VISITED_SKILL_LIMIT = 5;
export const RECENT_UPDATED_SKILL_LIMIT = 10;

/**
 * Intersect the per-browser recently-visited ids with the fetched skills list,
 * most-recent-first, capped at `limit`. Stale/foreign ids that no longer match
 * a live skill drop out automatically (they simply miss the lookup).
 */
export function orderRecentlyVisitedSkills(
  skills: CompanySkillListItem[],
  recentIds: string[],
  limit = RECENT_VISITED_SKILL_LIMIT,
): CompanySkillListItem[] {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const ordered: CompanySkillListItem[] = [];
  const seen = new Set<string>();
  for (const id of recentIds) {
    if (seen.has(id)) continue;
    const skill = byId.get(id);
    if (!skill) continue;
    ordered.push(skill);
    seen.add(id);
    if (ordered.length >= limit) break;
  }
  return ordered;
}

function updatedAtMs(skill: Pick<CompanySkillListItem, "updatedAt">): number {
  const value = skill.updatedAt as unknown;
  const time =
    value instanceof Date ? value.getTime() : new Date(value as string).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Top `limit` skills by `updatedAt` desc, excluding anything already surfaced in
 * the visited section (dedupe by id). Ties break by name so ordering is stable.
 */
export function orderRecentlyUpdatedSkills(
  skills: CompanySkillListItem[],
  excludeIds: Iterable<string>,
  limit = RECENT_UPDATED_SKILL_LIMIT,
): CompanySkillListItem[] {
  const excluded = new Set(excludeIds);
  return skills
    .filter((skill) => !excluded.has(skill.id))
    .slice()
    .sort((a, b) => {
      const delta = updatedAtMs(b) - updatedAtMs(a);
      return delta !== 0 ? delta : a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

export interface SkillEditorAvatar {
  name: string;
  imageUrl: string | null;
  initials: string;
}

function editorInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Gate the last-editor avatar to human edits only. Agent edits and
 * unattributed syncs (`kind !== "user"`, or no editor) render nothing.
 */
export function skillEditorAvatar(
  lastEditor: CompanySkillLastEditor | null | undefined,
): SkillEditorAvatar | null {
  if (!lastEditor || lastEditor.kind !== "user") return null;
  const name = lastEditor.name?.trim() || "Unknown editor";
  return {
    name,
    imageUrl: lastEditor.imageUrl,
    initials: editorInitials(name),
  };
}
