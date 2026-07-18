import {
  Component,
  type ClipboardEvent,
  type ErrorInfo,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  CodeMirrorEditor,
  MDXEditor,
  codeBlockPlugin,
  codeMirrorPlugin,
  type CodeBlockEditorDescriptor,
  type MDXEditorMethods,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  type RealmPlugin,
} from "@mdxeditor/editor";
import {
  buildAgentMentionHref,
  buildIssueReferenceHref,
  buildProjectMentionHref,
  buildRoutineMentionHref,
  buildUserMentionHref,
} from "@paperclipai/shared";
import { Boxes, CalendarClock, Hash, User } from "lucide-react";
import { AgentIcon } from "./AgentIconPicker";
import { applyMentionChipDecoration, clearMentionChipDecoration, parseMentionChipHref } from "../lib/mention-chips";
import { MentionAwareLinkNode, mentionAwareLinkNodeReplacement } from "../lib/mention-aware-link-node";
import { mentionDeletionPlugin } from "../lib/mention-deletion";
import { looksLikeMarkdownPaste } from "../lib/markdownPaste";
import { normalizeMarkdown } from "../lib/normalize-markdown";
import { pasteNormalizationPlugin } from "../lib/paste-normalization";
import { cn } from "../lib/utils";
import { useEditorAutocomplete, type SlashCommandOption } from "../context/EditorAutocompleteContext";
import { TtsDebugLog, describeBeforeInput, isTtsDebugEnabled } from "../lib/tts-debug";
import { TtsDebugPanel } from "./TtsDebugPanel";

/* ---- Mention types ---- */

export interface MentionOption {
  id: string;
  name: string;
  kind?: "agent" | "project" | "user" | "issue";
  agentId?: string;
  agentIcon?: string | null;
  projectId?: string;
  projectColor?: string | null;
  userId?: string;
  /** Issue/task references (PAP-95f). `name` carries the searchable identifier + title. */
  issueId?: string;
  issueIdentifier?: string;
}

/* ---- Editor props ---- */

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  contentClassName?: string;
  onBlur?: () => void;
  imageUploadHandler?: (file: File) => Promise<string>;
  /** Called when a non-image file is dropped onto the editor (e.g. .zip). */
  onDropFile?: (file: File) => Promise<void>;
  /** When set to `parent`, a wrapper owns drag/drop behavior and visuals. */
  fileDropTarget?: "editor" | "parent";
  bordered?: boolean;
  /** List of mentionable entities. Enables @-mention autocomplete. */
  mentions?: MentionOption[];
  /** Called on Cmd/Ctrl+Enter */
  onSubmit?: () => void;
  /** Render the rich editor without allowing edits. */
  readOnly?: boolean;
}

export interface MarkdownEditorRef {
  focus: () => void;
  insertMarkdown: (markdown: string) => void;
}

class MarkdownEditorRichErrorBoundary extends Component<
  { children: ReactNode; onError: (error: unknown) => void },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Markdown rich editor failed; falling back to raw textarea", {
      error,
      componentStack: info.componentStack,
    });
    this.props.onError(error);
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

function readHtmlAttribute(attrs: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return match?.[2] ?? match?.[3] ?? match?.[4] ?? null;
}

function convertHtmlImagesToMarkdown(text: string): string {
  return text.replace(/<img\b([^>]*?)\/?>/gi, (tag, attrs: string) => {
    const src = readHtmlAttribute(attrs, "src");
    if (!src) return tag;
    const alt = readHtmlAttribute(attrs, "alt") ?? "image";
    const title = readHtmlAttribute(attrs, "title");
    const escapedAlt = alt.replace(/[[\]]/g, "\\$&");
    const escapedTitle = title?.replace(/"/g, '\\"');
    return escapedTitle
      ? `![${escapedAlt}](${src} "${escapedTitle}")`
      : `![${escapedAlt}](${src})`;
  });
}

function prepareMarkdownForEditor(value: string): string {
  const normalizedLineEndings = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return convertHtmlImagesToMarkdown(normalizedLineEndings);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasMeaningfulEditorContent(node: Node | null): boolean {
  if (!node) return false;
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").trim().length > 0;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }

  const element = node as HTMLElement;
  if (["IMG", "HR", "TABLE", "VIDEO", "IFRAME"].includes(element.tagName)) {
    return true;
  }

  return Array.from(element.childNodes).some((child) => hasMeaningfulEditorContent(child));
}

function hasMarkdownImage(value: string): boolean {
  return /!\[[\s\S]*?\]\([^)]+\)/.test(value);
}

function isRichEditorDomEmpty(
  editable: HTMLElement,
  expectedValue: string,
  placeholder?: string,
): boolean {
  const expectedText = expectedValue.trim();
  if (!expectedText) return false;
  const expectedHasImage = hasMarkdownImage(expectedText);

  const visibleText = (editable.textContent ?? "").trim();
  if (visibleText.length === 0) {
    if (expectedHasImage) return false;
    return !Array.from(editable.childNodes).some((child) => hasMeaningfulEditorContent(child));
  }

  const normalizedPlaceholder = placeholder?.trim();
  if (
    normalizedPlaceholder
    && visibleText === normalizedPlaceholder
    && expectedText !== normalizedPlaceholder
  ) {
    if (expectedHasImage) return false;
    return true;
  }

  return false;
}

function isSafeMarkdownLinkUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return true;
  return !/^(javascript|data|vbscript):/i.test(trimmed);
}

function richEditorErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Rich editor failed to render";
}

/* ---- Mention detection helpers ---- */

interface MentionState {
  trigger: "mention" | "skill";
  marker: "@" | "/";
  query: string;
  top: number;
  left: number;
  /**
   * Caret-aligned viewport coords for portal positioning. `viewportTop` /
   * `viewportBottom` describe the active text line, and `viewportLeft` is the
   * caret X (right edge of the last typed character) so the menu can sit on
   * the same line, just to the right of the cursor.
   */
  viewportTop: number;
  viewportBottom: number;
  viewportLeft: number;
  textNode: Text;
  atPos: number;
  endPos: number;
}

type AutocompleteOption = MentionOption | SlashCommandOption;

interface MentionMenuViewport {
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
}

interface MentionMenuSize {
  width: number;
  height: number;
}

const MENTION_MENU_WIDTH = 188;
const MENTION_MENU_HEIGHT = 208;
const MENTION_MENU_PADDING = 8;
const MENTION_MENU_ROW_HEIGHT = 34;
const MENTION_MENU_CHROME_HEIGHT = 8;
const MAX_AUTOCOMPLETE_OPTIONS = 50;
/** Roughly one space-width of breathing room between the caret and the menu. */
const MENTION_MENU_CARET_GAP = 10;
/**
 * NEO-411: how long after the last input event we consider the editor "settled"
 * and safe to reconcile a controlled-value change into it. iOS dictation streams
 * `insertText` events a few hundred ms apart, so this window must comfortably span
 * the gaps within one dictation burst without stranding a legitimate external
 * update for long once input actually stops.
 */
const INPUT_SETTLE_MS = 350;

const CODE_BLOCK_LANGUAGES: Record<string, string> = {
  txt: "Text",
  md: "Markdown",
  js: "JavaScript",
  jsx: "JavaScript (JSX)",
  ts: "TypeScript",
  tsx: "TypeScript (TSX)",
  json: "JSON",
  bash: "Bash",
  sh: "Shell",
  python: "Python",
  go: "Go",
  rust: "Rust",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  yaml: "YAML",
  yml: "YAML",
};

const FALLBACK_CODE_BLOCK_DESCRIPTOR: CodeBlockEditorDescriptor = {
  // Keep this lower than codeMirrorPlugin's descriptor priority so known languages
  // still use the standard matching path; this catches malformed/unknown fences.
  priority: 0,
  match: () => true,
  Editor: CodeMirrorEditor,
};

export function findMentionMatch(
  text: string,
  offset: number,
): Pick<MentionState, "trigger" | "marker" | "query" | "atPos" | "endPos"> | null {
  let atPos = -1;
  let trigger: MentionState["trigger"] | null = null;
  let marker: MentionState["marker"] | null = null;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@" || ch === "/") {
      if (i === 0 || /\s/.test(text[i - 1])) {
        atPos = i;
        trigger = ch === "@" ? "mention" : "skill";
        marker = ch;
      }
      break;
    }
    if (ch === "\n" || ch === "\r") break;
  }

  if (atPos === -1) return null;
  const query = text.slice(atPos + 1, offset);
  if (trigger === "skill" && /\s/.test(query) && !query.toLowerCase().startsWith("routine:")) {
    return null;
  }

  return {
    trigger: trigger ?? "mention",
    marker: marker ?? "@",
    query,
    atPos,
    endPos: offset,
  };
}

interface CaretRect {
  top: number;
  bottom: number;
  /** Caret X — the right edge of the last typed character (or left edge of the next). */
  x: number;
}

function measureCaretRect(textNode: Text, offset: number, atPos: number): CaretRect {
  const length = textNode.textContent?.length ?? 0;
  const rectFromRange = (start: number, end: number, side: "right" | "left"): CaretRect | null => {
    if (start < 0 || end > length || end <= start) return null;
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { top: rect.top, bottom: rect.bottom, x: side === "right" ? rect.right : rect.left };
  };

  // Prefer the character immediately before the caret — its right edge IS the caret X
  // and its top/bottom describe the active line. Falls back to the char after the caret
  // and finally the @ marker if nothing else gives us a valid rect.
  return (
    rectFromRange(Math.max(0, offset - 1), offset, "right")
    ?? rectFromRange(offset, Math.min(length, offset + 1), "left")
    ?? rectFromRange(atPos, atPos + 1, "right")
    ?? { top: 0, bottom: 0, x: 0 }
  );
}

function detectMention(container: HTMLElement): MentionState | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;

  const range = sel.getRangeAt(0);
  const textNode = range.startContainer;
  if (textNode.nodeType !== Node.TEXT_NODE) return null;
  if (!container.contains(textNode)) return null;

  const text = textNode.textContent ?? "";
  const offset = range.startOffset;
  const match = findMentionMatch(text, offset);
  if (!match) return null;

  // Anchor the menu to the live caret so it tracks each typed character instead of
  // staying glued to the @ marker.
  const caret = measureCaretRect(textNode as Text, offset, match.atPos);
  const containerRect = container.getBoundingClientRect();

  return {
    trigger: match.trigger,
    marker: match.marker,
    query: match.query,
    top: caret.top - containerRect.top,
    left: caret.x - containerRect.left,
    viewportTop: caret.top,
    viewportBottom: caret.bottom,
    viewportLeft: caret.x,
    textNode: textNode as Text,
    atPos: match.atPos,
    endPos: match.endPos,
  };
}

function getMentionMenuViewport(): MentionMenuViewport {
  const viewport = window.visualViewport;
  if (viewport) {
    return {
      offsetLeft: viewport.offsetLeft,
      offsetTop: viewport.offsetTop,
      width: viewport.width,
      height: viewport.height,
    };
  }

  return {
    offsetLeft: 0,
    offsetTop: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

export function computeMentionMenuPosition(
  anchor: Pick<MentionState, "viewportTop" | "viewportBottom" | "viewportLeft">,
  viewport: MentionMenuViewport,
  menuSize: MentionMenuSize = { width: MENTION_MENU_WIDTH, height: MENTION_MENU_HEIGHT },
) {
  const minLeft = viewport.offsetLeft + MENTION_MENU_PADDING;
  const maxLeft = viewport.offsetLeft + viewport.width - menuSize.width;
  const minTop = viewport.offsetTop + MENTION_MENU_PADDING;
  const maxTop = viewport.offsetTop + viewport.height - menuSize.height;

  // Place the menu's top edge on the current line so it sits next to the caret.
  // If it would overflow below, flip above so the menu's bottom hugs the line.
  const desiredTop = viewport.offsetTop + anchor.viewportTop;
  let top: number;
  if (desiredTop > maxTop) {
    const flipped = viewport.offsetTop + anchor.viewportBottom - menuSize.height;
    top = Math.max(minTop, Math.min(flipped, maxTop));
  } else {
    top = Math.max(minTop, desiredTop);
  }

  // Place the menu's left edge a small gap to the right of the caret X so
  // there's roughly a space-width of breathing room between cursor and menu.
  const desiredLeft = viewport.offsetLeft + anchor.viewportLeft + MENTION_MENU_CARET_GAP;
  const left = Math.max(minLeft, Math.min(desiredLeft, maxLeft));

  return { top, left };
}

function getMentionMenuSize(optionCount: number): MentionMenuSize {
  const visibleRows = Math.max(1, Math.min(optionCount, 8));
  return {
    width: MENTION_MENU_WIDTH,
    height: Math.min(
      MENTION_MENU_HEIGHT,
      visibleRows * MENTION_MENU_ROW_HEIGHT + MENTION_MENU_CHROME_HEIGHT,
    ),
  };
}

function nodeInsideCodeLike(container: HTMLElement, node: Node | null): boolean {
  if (!node || !container.contains(node)) return false;
  const el = node.nodeType === Node.ELEMENT_NODE
    ? (node as HTMLElement)
    : node.parentElement;
  return Boolean(el?.closest("pre, code"));
}

function isSelectionInsideCodeLikeElement(container: HTMLElement | null) {
  if (!container) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  for (const node of [selection.anchorNode, selection.focusNode]) {
    if (nodeInsideCodeLike(container, node)) return true;
  }
  return false;
}

/** The human title of an issue mention — `name` minus its leading identifier. */
export function issueMentionTitle(option: MentionOption): string {
  const name = option.name.trim();
  const identifier = option.issueIdentifier?.trim();
  if (identifier && name.toLowerCase().startsWith(identifier.toLowerCase())) {
    return name.slice(identifier.length).trim();
  }
  return name;
}

function mentionMarkdown(option: MentionOption): string {
  if (option.kind === "issue" && option.issueIdentifier) {
    // Insert a compact issue link (e.g. `[PAP-123](/issues/PAP-123)`). The chip
    // decorator recognizes this href as an `issue` mention and renders it as a
    // task chip; MarkdownBody linkifies the same href on display.
    return `[${option.issueIdentifier}](${buildIssueReferenceHref(option.issueIdentifier)}) `;
  }
  if (option.kind === "project" && option.projectId) {
    return `[@${option.name}](${buildProjectMentionHref(option.projectId, option.projectColor ?? null)}) `;
  }
  if (option.kind === "user" && option.userId) {
    return `[@${option.name}](${buildUserMentionHref(option.userId)}) `;
  }
  const agentId = option.agentId ?? option.id.replace(/^agent:/, "");
  return `[@${option.name}](${buildAgentMentionHref(agentId, option.agentIcon ?? null)}) `;
}

function slashCommandLabel(option: SlashCommandOption): string {
  return option.kind === "routine" ? `/routine:${option.name}` : `/${option.slug}`;
}

function slashCommandMarkdown(option: SlashCommandOption): string {
  if (option.kind === "routine") {
    return `[${slashCommandLabel(option)}](${buildRoutineMentionHref(option.routineId)}) `;
  }
  return `[/${option.slug}](${option.href}) `;
}

function autocompleteMarkdown(option: AutocompleteOption): string {
  return option.kind === "skill" || option.kind === "routine"
    ? slashCommandMarkdown(option)
    : mentionMarkdown(option);
}

export function shouldAcceptAutocompleteKey(
  key: string,
  trigger: MentionState["trigger"] | null,
  skillEnterArmed = false,
): boolean {
  if (key === "Tab") return true;
  if (key !== "Enter") return false;
  return trigger === "mention" || (trigger === "skill" && skillEnterArmed);
}

export function isSameAutocompleteSession(
  left: Pick<MentionState, "trigger" | "marker" | "query" | "textNode" | "atPos" | "endPos"> | null,
  right: Pick<MentionState, "trigger" | "marker" | "query" | "textNode" | "atPos" | "endPos"> | null,
): boolean {
  if (!left || !right) return false;
  return left.trigger === right.trigger
    && left.marker === right.marker
    && left.query === right.query
    && left.textNode === right.textNode
    && left.atPos === right.atPos
    && left.endPos === right.endPos;
}

function autocompleteOptionMatchesLink(option: AutocompleteOption, href: string): boolean {
  const parsed = parseMentionChipHref(href);
  if (!parsed) return false;

  if (option.kind === "skill") {
    return parsed.kind === "skill" && parsed.skillId === option.skillId;
  }
  if (option.kind === "routine") {
    return parsed.kind === "routine" && parsed.routineId === option.routineId;
  }

  if (option.kind === "issue" && option.issueIdentifier) {
    return parsed.kind === "issue" && parsed.identifier === option.issueIdentifier;
  }
  if (option.kind === "project" && option.projectId) {
    return parsed.kind === "project" && parsed.projectId === option.projectId;
  }
  if (option.kind === "user" && option.userId) {
    return parsed.kind === "user" && parsed.userId === option.userId;
  }

  const agentId = option.agentId ?? option.id.replace(/^agent:/, "");
  return parsed.kind === "agent" && parsed.agentId === agentId;
}

export function findClosestAutocompleteAnchor(
  editable: HTMLElement,
  option: AutocompleteOption,
  origin?: Pick<MentionState, "left" | "top"> | null,
): HTMLAnchorElement | null {
  const matchingMentions = Array.from(editable.querySelectorAll("a"))
    .filter((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement)
    .filter((link) => autocompleteOptionMatchesLink(option, link.getAttribute("href") ?? ""));

  if (matchingMentions.length === 0) return null;
  if (!origin) return matchingMentions[0] ?? null;

  const containerRect = editable.getBoundingClientRect();
  return matchingMentions.sort((a, b) => {
    const rectA = a.getBoundingClientRect();
    const rectB = b.getBoundingClientRect();
    const leftA = rectA.left - containerRect.left;
    const topA = rectA.top - containerRect.top;
    const leftB = rectB.left - containerRect.left;
    const topB = rectB.top - containerRect.top;
    const distA = Math.hypot(leftA - origin.left, topA - origin.top);
    const distB = Math.hypot(leftB - origin.left, topB - origin.top);
    return distA - distB;
  })[0] ?? null;
}

export function placeCaretAfterMentionAnchor(target: HTMLAnchorElement): boolean {
  const selection = window.getSelection();
  if (!selection) return false;

  const range = document.createRange();
  const nextSibling = target.nextSibling;
  if (nextSibling?.nodeType === Node.TEXT_NODE) {
    const text = nextSibling.textContent ?? "";
    if (text.startsWith(" ")) {
      range.setStart(nextSibling, 1);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    if (text.length > 0) {
      range.setStart(nextSibling, 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
  }

  range.setStartAfter(target);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** Replace the active autocomplete token in the markdown string with the selected token. */
function applyMention(markdown: string, state: MentionState, option: AutocompleteOption): string {
  const search = `${state.marker}${state.query}`;
  const replacement = autocompleteMarkdown(option);
  const idx = markdown.lastIndexOf(search);
  if (idx === -1) return markdown;
  return markdown.slice(0, idx) + replacement + markdown.slice(idx + search.length);
}

/* ---- Component ---- */

export const MarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(function MarkdownEditor({
  value,
  onChange,
  placeholder,
  className,
  contentClassName,
  onBlur,
  imageUploadHandler,
  onDropFile,
  fileDropTarget = "editor",
  bordered = true,
  mentions,
  onSubmit,
  readOnly = false,
}: MarkdownEditorProps, forwardedRef) {
  const editorValue = useMemo(() => prepareMarkdownForEditor(value), [value]);
  const { slashCommands } = useEditorAutocomplete();
  const containerRef = useRef<HTMLDivElement>(null);
  const ref = useRef<MDXEditorMethods>(null);
  const fallbackTextareaRef = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef(editorValue);
  valueRef.current = editorValue;
  const latestValueRef = useRef(editorValue);
  const initialChildOnChangeRef = useRef(true);
  /**
   * After imperative `setMarkdown` (prop sync, mentions, image upload), MDXEditor may emit `onChange`
   * with the same markdown. Skip notifying the parent for that echo so controlled parents that
   * normalize or transform values cannot loop. Replaces the older blur/focus gate for the same concern.
   */
  const echoIgnoreMarkdownRef = useRef<string | null>(null);
  /**
   * NEO-411: true while the OS/user is actively feeding input into the editor
   * (typing, iOS dictation `insertText` stream, or desktop IME composition).
   * While true we do NOT push a controlled-value change back in via
   * `setMarkdown` — doing so mid-stream desyncs the editor from the OS input
   * buffer (the iPhone-dictation duplication in NEO-405). A deferred external
   * update is flushed once input settles, so remote/external changes are never
   * swallowed — only postponed. Driven by `beforeinput`/`input` (iOS dictation
   * never emits composition events) and composition events (CJK / macOS IME).
   */
  const inputActiveRef = useRef(false);
  const inputSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * NEO-411 rev 8: the authoritative transcript of an in-flight iOS dictation.
   * iOS dictation streams full-field-replace `insertText` events whose `data` is
   * the whole cumulative text; we latch the latest such `data` here (including the
   * paragraph-break replace that Lexical drops with no `onChange`). At commit iOS
   * re-lays the whole transcript as a same-tick burst of *collapsed* inserts that
   * duplicates (or, at scattered offsets, eats) text — corrupting what the editor
   * emits. On settle we reconcile back to this latched transcript once, so the
   * spoken text lands verbatim exactly once. `null` when no dictation is in flight.
   */
  const dictationTranscriptRef = useRef<string | null>(null);
  /** True between compositionstart/compositionend (desktop CJK / macOS IME). iOS
   * dictation never composes; gating transcript capture on this keeps the repair
   * off the IME path the plan's Risks call out. */
  const isComposingRef = useRef(false);
  /** Latest parent onChange, kept in a ref so the settle repair can emit without
   * churning `markInputActive`/listener identity across renders. */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [richEditorError, setRichEditorError] = useState<string | null>(null);
  const dragDepthRef = useRef(0);

  /* ---- NEO-405/NEO-409 dictation logging harness (instrumentation only) ---- */
  // Gated opt-in, evaluated once per mount. When false, every hook below is a
  // no-op and no listeners are attached, so normal users are unaffected.
  const ttsDebug = useMemo(() => isTtsDebugEnabled(), []);
  const ttsLogRef = useRef<TtsDebugLog | null>(null);
  if (ttsDebug && !ttsLogRef.current) ttsLogRef.current = new TtsDebugLog();
  // Capture is a PURE append to the ref buffer — no setState, so recording an
  // event never re-renders the editor subtree. The panel (<TtsDebugPanel>) reads
  // the buffer on its own interval from a portal outside this tree. This is the
  // NEO-409 observer-effect fix: the instrument must not perturb the setMarkdown
  // reconcile timing it measures.
  const recordTts = useCallback(
    (type: string, detail: Record<string, unknown> = {}) => {
      ttsLogRef.current?.record(type, detail);
    },
    [],
  );

  // Stable ref for imageUploadHandler so plugins don't recreate on every render
  const imageUploadHandlerRef = useRef(imageUploadHandler);
  imageUploadHandlerRef.current = imageUploadHandler;

  // Mention state (ref kept in sync so callbacks always see the latest value)
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const mentionStateRef = useRef<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const autocompleteOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const skillEnterArmedRef = useRef(false);
  const autocompleteSelectionHandledRef = useRef(false);
  const mentionActive = mentionState !== null && (
    (mentionState.trigger === "mention" && Boolean(mentions?.length))
    || (mentionState.trigger === "skill" && slashCommands.length > 0)
  );
  const mentionOptionByKey = useMemo(() => {
    const map = new Map<string, MentionOption>();
    for (const mention of mentions ?? []) {
      if (mention.kind === "agent") {
        const agentId = mention.agentId ?? mention.id.replace(/^agent:/, "");
        map.set(`agent:${agentId}`, mention);
      }
      if (mention.kind === "user" && mention.userId) {
        map.set(`user:${mention.userId}`, mention);
      }
      if (mention.kind === "project" && mention.projectId) {
        map.set(`project:${mention.projectId}`, mention);
      }
    }
    return map;
  }, [mentions]);

  const setEditorRef = useCallback((instance: MDXEditorMethods | null) => {
    ref.current = instance;
    if (!instance) {
      return;
    }
    if (valueRef.current !== latestValueRef.current) {
      // Re-apply the latest controlled value once MDXEditor exposes its imperative API.
      echoIgnoreMarkdownRef.current = valueRef.current;
      recordTts("setMarkdown", { origin: "ref-attach", len: valueRef.current.length });
      instance.setMarkdown(valueRef.current);
      latestValueRef.current = valueRef.current;
    }
  }, [recordTts]);

  const filteredMentions = useMemo<AutocompleteOption[]>(() => {
    if (!mentionState) return [];
    const q = mentionState.query.trim().toLowerCase();
    if (mentionState.trigger === "skill") {
      return slashCommands
        .filter((command) => {
          if (!q) return true;
          return command.aliases.some((alias) => alias.toLowerCase().includes(q));
        })
        .slice(0, MAX_AUTOCOMPLETE_OPTIONS);
    }
    if (!mentions) return [];
    return mentions
      .filter((m) => m.name.toLowerCase().includes(q))
      .slice(0, MAX_AUTOCOMPLETE_OPTIONS);
  }, [mentionState, mentions, slashCommands]);

  const insertMarkdown = useCallback((markdown: string) => {
    if (readOnly) return;
    if (!richEditorError && ref.current) {
      ref.current.insertMarkdown(markdown);
      return;
    }
    const textarea = fallbackTextareaRef.current;
    if (!textarea) {
      onChange(`${value}${markdown}`);
      return;
    }
    const start = textarea.selectionStart ?? value.length;
    const end = textarea.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${markdown}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      textarea.focus();
      const cursor = start + markdown.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  }, [onChange, readOnly, richEditorError, value]);

  useImperativeHandle(forwardedRef, () => ({
    focus: () => {
      if (richEditorError) {
        fallbackTextareaRef.current?.focus();
        return;
      }
      ref.current?.focus(undefined, { defaultSelection: "rootEnd" });
    },
    insertMarkdown,
  }), [insertMarkdown, richEditorError]);

  const autoSizeFallbackTextarea = useCallback((element: HTMLTextAreaElement | null) => {
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, []);

  useEffect(() => {
    if (!richEditorError) return;
    autoSizeFallbackTextarea(fallbackTextareaRef.current);
  }, [autoSizeFallbackTextarea, richEditorError, value]);

  useEffect(() => {
    if (richEditorError || editorValue.trim().length === 0) return;
    const container = containerRef.current;
    if (!container) return;

    let timeoutId = 0;
    const scheduleCheck = () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        const editable = container.querySelector('[contenteditable="true"]');
        if (!(editable instanceof HTMLElement)) return;
        const activeElement = document.activeElement;
        if (activeElement === editable || editable.contains(activeElement)) return;
        if (isRichEditorDomEmpty(editable, editorValue, placeholder)) {
          setRichEditorError("Rich editor failed to load content");
        }
      }, 0);
    };

    scheduleCheck();
    const observer = new MutationObserver(() => {
      scheduleCheck();
    });
    observer.observe(container, {
      subtree: true,
      childList: true,
      characterData: true,
    });

    return () => {
      window.clearTimeout(timeoutId);
      observer.disconnect();
    };
  }, [editorValue, placeholder, richEditorError]);

  // Whether the image plugin should be included (boolean is stable across renders
  // as long as the handler presence doesn't toggle)
  const hasImageUpload = Boolean(imageUploadHandler);

  const plugins = useMemo<RealmPlugin[]>(() => {
    const imageHandler = hasImageUpload
      ? async (file: File) => {
          const handler = imageUploadHandlerRef.current;
          if (!handler) throw new Error("No image upload handler");
          try {
            const src = await handler(file);
            setUploadError(null);
            // After MDXEditor inserts the image, ensure two newlines follow it
            // so the cursor isn't stuck right next to the image.
            setTimeout(() => {
              const current = latestValueRef.current;
              const escapedSrc = escapeRegExp(src);
              const updated = current.replace(
                new RegExp(`(!\\[[^\\]]*\\]\\(${escapedSrc}\\))(?!\\n\\n)`, "g"),
                "$1\n\n",
              );
              if (updated !== current) {
                latestValueRef.current = updated;
                echoIgnoreMarkdownRef.current = updated;
                recordTts("setMarkdown", { origin: "image", len: updated.length });
                ref.current?.setMarkdown(updated);
                onChange(updated);
                requestAnimationFrame(() => {
                  ref.current?.focus(undefined, { defaultSelection: "rootEnd" });
                });
              }
            }, 100);
            return src;
          } catch (err) {
            const message = err instanceof Error ? err.message : "Image upload failed";
            setUploadError(message);
            throw err;
          }
        }
      : undefined;
    const all: RealmPlugin[] = [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      tablePlugin(),
      linkPlugin({ validateUrl: isSafeMarkdownLinkUrl }),
      linkDialogPlugin(),
      mentionDeletionPlugin(),
      pasteNormalizationPlugin(),
      thematicBreakPlugin(),
      codeBlockPlugin({
        defaultCodeBlockLanguage: "txt",
        codeBlockEditorDescriptors: [FALLBACK_CODE_BLOCK_DESCRIPTOR],
      }),
      codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
      markdownShortcutPlugin(),
    ];
    if (imageHandler) {
      all.push(imagePlugin({ imageUploadHandler: imageHandler }));
    }
    return all;
  }, [hasImageUpload]);

  // Push a controlled-value change into the editor. Pairs with the onChange echo
  // suppression (echoIgnoreMarkdownRef) so the resulting onChange doesn't loop.
  const applyReconcile = useCallback((nextEditorValue: string) => {
    const instance = ref.current;
    if (!instance) return;
    echoIgnoreMarkdownRef.current = nextEditorValue;
    recordTts("setMarkdown", { origin: "prop-sync", len: nextEditorValue.length });
    instance.setMarkdown(nextEditorValue);
    latestValueRef.current = nextEditorValue;
  }, [recordTts]);

  // Whether the editor already holds `candidate` — either verbatim (our own
  // echoed onChange round-trip) or once normalized through the same prepare step
  // the controlled value goes through. NEO-411 Phase 2: an editor-originated
  // value that round-trips back as the controlled prop must never re-enter
  // setMarkdown, so we compare against the *last value the editor emitted*
  // rather than only the raw-prepared value.
  const editorAlreadyHolds = useCallback((candidate: string) => {
    const lastEmitted = latestValueRef.current;
    return candidate === lastEmitted || candidate === prepareMarkdownForEditor(lastEmitted);
  }, []);

  // Mark input as active and (re)arm the settle timer. When input finally stops,
  // flush any controlled-value change that was deferred while input was flowing.
  const markInputActive = useCallback(() => {
    inputActiveRef.current = true;
    if (inputSettleTimerRef.current) clearTimeout(inputSettleTimerRef.current);
    inputSettleTimerRef.current = setTimeout(() => {
      inputSettleTimerRef.current = null;
      inputActiveRef.current = false;
      // NEO-411 rev 8 — dictation commit-burst repair. If iOS dictation ran this
      // session we hold its authoritative transcript. The commit burst may have
      // duplicated or eaten text in what the editor actually emitted; reconcile
      // back to the transcript once so the spoken text lands verbatim (and the
      // paragraph break the transcript carries survives). Authoritative for this
      // settle — we skip the external reconcile below, since the parent's value
      // currently holds the corrupted emit and would just fight this.
      const transcript = dictationTranscriptRef.current;
      dictationTranscriptRef.current = null;
      if (transcript !== null && ref.current) {
        const prepared = prepareMarkdownForEditor(transcript);
        if (prepared !== latestValueRef.current) {
          echoIgnoreMarkdownRef.current = prepared;
          recordTts("setMarkdown", { origin: "dictation-repair", len: prepared.length });
          ref.current.setMarkdown(prepared);
          latestValueRef.current = prepared;
          onChangeRef.current(transcript);
          return;
        }
        // Clean dictation (editor already emitted the transcript verbatim) — fall
        // through so a genuine external update isn't stranded.
      }
      // valueRef holds the freshest prepared controlled value. Flush only a
      // genuine external change; an editor-originated value the editor already
      // holds is dropped (no self-inflicted round-trip).
      if (ref.current && !editorAlreadyHolds(valueRef.current)) {
        applyReconcile(valueRef.current);
      }
    }, INPUT_SETTLE_MS);
  }, [applyReconcile, editorAlreadyHolds, recordTts]);

  // NEO-411 Phase 1+2: reconcile the controlled value into the editor, but never
  // while input is actively streaming (defer to settle) and never for a value the
  // editor already emitted (drop the round-trip).
  //
  // NEO-419d: trigger ONLY on `editorValue`. `applyReconcile`/`editorAlreadyHolds`
  // are memoized on `recordTts`, which churns identity across renders; listing them
  // here made the effect re-fire on spurious renders and race the editor's own
  // content commit, stranding async-loaded external values as empty content
  // ("applies async external value updates once the editor ref becomes ready").
  // Both callbacks read live refs, so excluding them from deps is safe.
  useEffect(() => {
    if (editorAlreadyHolds(editorValue)) return;
    if (!ref.current) return;
    // Defer while dictation/composition/typing is in flight; the settle timer
    // flushes the latest controlled value once input stops.
    if (inputActiveRef.current) return;
    applyReconcile(editorValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorValue]);

  // NEO-411 Phase 1: track active input at the container so the reconcile effect
  // above can gate on it. Capture-phase + container-level so it survives the
  // contenteditable remounting and sees events before Lexical consumes them.
  // Always attached (not gated behind the debug harness) — this is the fix path.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onInputActivity = () => markInputActive();
    // NEO-411 rev 8: composition = desktop CJK / macOS IME. iOS dictation never
    // composes, so we only latch a dictation transcript while NOT composing —
    // keeping the repair off the IME path (plan Risks: don't disturb CJK/macOS).
    const onCompositionStart = () => { isComposingRef.current = true; };
    const onCompositionEnd = () => { isComposingRef.current = false; };
    // NEO-411 rev 8: latch the iOS dictation transcript. A full-field-replace
    // `insertText`/`insertReplacementText` carries the whole cumulative text in
    // `data` (length >= the current field) — that's dictation streaming, and also
    // the paragraph-break replace Lexical drops silently. Normal typing (collapsed,
    // 1-char data), selection-replace (data shorter than the field), and paste
    // (`insertFromPaste`) are all excluded, so `dictationTranscriptRef` only ever
    // holds a real dictation transcript. The collapsed commit-burst inserts are
    // shorter than the field too, so they never overwrite the latched transcript.
    const onBeforeInputCapture = (event: Event) => {
      if (!(event instanceof InputEvent)) return;
      if (isComposingRef.current) return;
      const { inputType, data } = event;
      if (inputType !== "insertText" && inputType !== "insertReplacementText") return;
      if (typeof data !== "string" || data.length <= 1) return;
      if (data.length >= latestValueRef.current.length) {
        dictationTranscriptRef.current = data;
      }
    };
    const events = ["beforeinput", "input", "compositionstart", "compositionupdate", "compositionend"];
    for (const type of events) container.addEventListener(type, onInputActivity, true);
    container.addEventListener("beforeinput", onBeforeInputCapture, true);
    container.addEventListener("compositionstart", onCompositionStart, true);
    container.addEventListener("compositionend", onCompositionEnd, true);
    return () => {
      for (const type of events) container.removeEventListener(type, onInputActivity, true);
      container.removeEventListener("beforeinput", onBeforeInputCapture, true);
      container.removeEventListener("compositionstart", onCompositionStart, true);
      container.removeEventListener("compositionend", onCompositionEnd, true);
      if (inputSettleTimerRef.current) {
        clearTimeout(inputSettleTimerRef.current);
        inputSettleTimerRef.current = null;
      }
    };
  }, [markInputActive]);

  // NEO-405/NEO-409: capture the raw input timeline (beforeinput + composition)
  // that Lexical/MDXEditor otherwise swallow. Container-level capture listeners
  // survive contenteditable remounts and catch the async `insertReplacementText`
  // corrections iOS delivers after dictation. Gated — attaches only when opted in.
  useEffect(() => {
    if (!ttsDebug) return;
    const container = containerRef.current;
    if (!container) return;

    const snapshotMarkdown = (): number => {
      try {
        return ref.current?.getMarkdown().length ?? -1;
      } catch {
        return -1;
      }
    };

    const onBeforeInput = (event: Event) => {
      if (!(event instanceof InputEvent)) return;
      recordTts("beforeinput", describeBeforeInput(event));
    };
    const onCompositionStart = (event: Event) => {
      recordTts("compositionstart", {
        data: (event as CompositionEvent).data ?? null,
        markdownLen: snapshotMarkdown(),
      });
    };
    const onCompositionUpdate = (event: Event) => {
      recordTts("compositionupdate", { data: (event as CompositionEvent).data ?? null });
    };
    const onCompositionEnd = (event: Event) => {
      recordTts("compositionend", {
        data: (event as CompositionEvent).data ?? null,
        markdownLen: snapshotMarkdown(),
      });
    };

    container.addEventListener("beforeinput", onBeforeInput, true);
    container.addEventListener("compositionstart", onCompositionStart, true);
    container.addEventListener("compositionupdate", onCompositionUpdate, true);
    container.addEventListener("compositionend", onCompositionEnd, true);
    return () => {
      container.removeEventListener("beforeinput", onBeforeInput, true);
      container.removeEventListener("compositionstart", onCompositionStart, true);
      container.removeEventListener("compositionupdate", onCompositionUpdate, true);
      container.removeEventListener("compositionend", onCompositionEnd, true);
    };
  }, [ttsDebug, recordTts]);

  const decorateProjectMentions = useCallback(() => {
    const editable = containerRef.current?.querySelector('[contenteditable="true"]');
    if (!editable) return;
    const links = editable.querySelectorAll("a");
    for (const node of links) {
      const link = node as HTMLAnchorElement;
      const parsed = parseMentionChipHref(link.getAttribute("href") ?? "");
      if (!parsed) {
        clearMentionChipDecoration(link);
        continue;
      }

      if (parsed.kind === "project") {
        const option = mentionOptionByKey.get(`project:${parsed.projectId}`);
        applyMentionChipDecoration(link, {
          ...parsed,
          color: parsed.color ?? option?.projectColor ?? null,
        });
        continue;
      }

      if (parsed.kind === "skill" || parsed.kind === "routine") {
        applyMentionChipDecoration(link, parsed);
        continue;
      }

      if (parsed.kind === "user" || parsed.kind === "issue") {
        applyMentionChipDecoration(link, parsed);
        continue;
      }

      const option = mentionOptionByKey.get(`agent:${parsed.agentId}`);
      applyMentionChipDecoration(link, {
        ...parsed,
        icon: parsed.icon ?? option?.agentIcon ?? null,
      });
    }
  }, [mentionOptionByKey]);

  // Mention detection: listen for selection changes and input events
  const checkMention = useCallback(() => {
    if (!containerRef.current || isSelectionInsideCodeLikeElement(containerRef.current)) {
      mentionStateRef.current = null;
      skillEnterArmedRef.current = false;
      setMentionState(null);
      return;
    }
    const result = detectMention(containerRef.current);
    if (
      result
      && result.trigger === "mention"
      && (!mentions || mentions.length === 0)
    ) {
      mentionStateRef.current = null;
      skillEnterArmedRef.current = false;
      setMentionState(null);
      return;
    }
    if (
      result
      && result.trigger === "skill"
      && slashCommands.length === 0
    ) {
      mentionStateRef.current = null;
      skillEnterArmedRef.current = false;
      setMentionState(null);
      return;
    }
    const previous = mentionStateRef.current;
    const sameSession = isSameAutocompleteSession(previous, result);
    mentionStateRef.current = result;
    if (!sameSession) {
      skillEnterArmedRef.current = false;
      setMentionIndex(0);
    }
    setMentionState(result);
  }, [mentions, slashCommands.length]);

  useEffect(() => {
    if ((!mentions || mentions.length === 0) && slashCommands.length === 0) return;

    const el = containerRef.current;
    // Listen for input events on the container so mention detection
    // also fires after typing (e.g. space to dismiss).
    const onInput = () => requestAnimationFrame(checkMention);

    document.addEventListener("selectionchange", checkMention);
    el?.addEventListener("input", onInput, true);
    return () => {
      document.removeEventListener("selectionchange", checkMention);
      el?.removeEventListener("input", onInput, true);
    };
  }, [checkMention, mentions, slashCommands.length]);

  useEffect(() => {
    if (!mentionActive) return;

    const updatePosition = () => requestAnimationFrame(checkMention);
    const viewport = window.visualViewport;

    viewport?.addEventListener("resize", updatePosition);
    viewport?.addEventListener("scroll", updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      viewport?.removeEventListener("resize", updatePosition);
      viewport?.removeEventListener("scroll", updatePosition);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [checkMention, mentionActive]);

  useEffect(() => {
    if (!mentionActive) return;
    autocompleteOptionRefs.current.length = filteredMentions.length;
    if (mentionIndex >= filteredMentions.length) {
      setMentionIndex(Math.max(0, filteredMentions.length - 1));
      return;
    }
    const activeOption = autocompleteOptionRefs.current[mentionIndex];
    if (!activeOption || typeof activeOption.scrollIntoView !== "function") return;
    activeOption.scrollIntoView({ block: "nearest" });
  }, [filteredMentions.length, mentionActive, mentionIndex]);

  useEffect(() => {
    if (mentionActive) return;
    autocompleteSelectionHandledRef.current = false;
  }, [mentionActive]);

  useEffect(() => {
    const editable = containerRef.current?.querySelector('[contenteditable="true"]');
    if (!editable) return;
    decorateProjectMentions();
    const observer = new MutationObserver(() => {
      decorateProjectMentions();
    });
    observer.observe(editable, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [decorateProjectMentions, value]);

  const selectMention = useCallback(
    (option: AutocompleteOption) => {
      // Read from ref to avoid stale-closure issues (selectionchange can
      // update state between the last render and this callback firing).
      const state = mentionStateRef.current;
      if (!state) return false;
      const current = latestValueRef.current;
      const next = applyMention(current, state, option);
      if (next !== current) {
        latestValueRef.current = next;
        echoIgnoreMarkdownRef.current = next;
        recordTts("setMarkdown", { origin: "mention", len: next.length });
        ref.current?.setMarkdown(next);
        onChange(next);
      }

      const restoreSelection = (attemptsRemaining: number) => {
        const editable = containerRef.current?.querySelector('[contenteditable="true"]');
        if (!(editable instanceof HTMLElement)) return;

        decorateProjectMentions();
        editable.focus();

        const target = findClosestAutocompleteAnchor(editable, option, state);
        if (!target) {
          if (attemptsRemaining > 0) {
            requestAnimationFrame(() => restoreSelection(attemptsRemaining - 1));
          }
          return;
        }

        placeCaretAfterMentionAnchor(target);
      };

      requestAnimationFrame(() => restoreSelection(4));

      mentionStateRef.current = null;
      skillEnterArmedRef.current = false;
      setMentionState(null);
      return true;
    },
    [decorateProjectMentions, onChange, recordTts],
  );

  const handleAutocompletePress = useCallback((
    event: ReactMouseEvent<HTMLButtonElement> | ReactPointerEvent<HTMLButtonElement> | ReactTouchEvent<HTMLButtonElement>,
    option: AutocompleteOption,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (autocompleteSelectionHandledRef.current) return;
    const handled = selectMention(option);
    if (handled) {
      autocompleteSelectionHandledRef.current = true;
    }
  }, [selectMention]);

  // Touch handling for the mention menu. We deliberately do NOT preventDefault
  // on touchstart so the browser can still scroll the menu vertically; instead
  // we record the start point and only treat the gesture as a selection if the
  // finger lifted with negligible movement (i.e., a tap, not a scroll).
  const touchStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const TOUCH_TAP_THRESHOLD_PX = 8;

  const handleAutocompleteTouchStart = useCallback((event: ReactTouchEvent<HTMLButtonElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    touchStartPointRef.current = { x: touch.clientX, y: touch.clientY };
  }, []);

  const handleAutocompleteTouchMove = useCallback((event: ReactTouchEvent<HTMLButtonElement>) => {
    const start = touchStartPointRef.current;
    if (!start) return;
    const touch = event.touches[0];
    if (!touch) return;
    if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > TOUCH_TAP_THRESHOLD_PX) {
      touchStartPointRef.current = null;
    }
  }, []);

  const handleAutocompleteTouchEnd = useCallback((
    event: ReactTouchEvent<HTMLButtonElement>,
    option: AutocompleteOption,
  ) => {
    const start = touchStartPointRef.current;
    touchStartPointRef.current = null;
    if (!start) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > TOUCH_TAP_THRESHOLD_PX) {
      return;
    }
    handleAutocompletePress(event, option);
  }, [handleAutocompletePress]);

  function hasFilePayload(evt: DragEvent<HTMLDivElement>) {
    return Array.from(evt.dataTransfer?.types ?? []).includes("Files");
  }

  const canDropFile = fileDropTarget === "editor" && Boolean(imageUploadHandler || onDropFile);
  const handlePasteCapture = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const clipboard = event.clipboardData;
    if (!clipboard || !ref.current) return;
    const types = new Set(Array.from(clipboard.types));
    if (types.has("Files") || types.has("text/html")) return;
    if (isSelectionInsideCodeLikeElement(containerRef.current)) return;

    const rawText = clipboard.getData("text/plain");
    if (!looksLikeMarkdownPaste(rawText)) return;

    event.preventDefault();
    ref.current.insertMarkdown(normalizeMarkdown(rawText));
  }, []);

  const handleRichEditorError = useCallback((error: unknown) => {
    setRichEditorError(richEditorErrorMessage(error));
  }, []);

  const mentionMenuPosition = mentionState
    ? computeMentionMenuPosition(
        mentionState,
        getMentionMenuViewport(),
        getMentionMenuSize(filteredMentions.length),
      )
    : null;

  if (richEditorError) {
    return (
      <div
        ref={containerRef}
        className={cn(
          "relative paperclip-mdxeditor-scope",
          bordered ? "rounded-md border border-border bg-transparent" : "bg-transparent",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3 px-3 pt-2 text-xs text-muted-foreground">
          <p>Rich editor unavailable for this markdown. Showing raw source instead.</p>
          <button
            type="button"
            className="shrink-0 underline underline-offset-2 hover:text-foreground"
            onClick={() => {
              setRichEditorError(null);
            }}
          >
            Retry rich editor
          </button>
        </div>
        <textarea
          ref={fallbackTextareaRef}
          value={value}
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={(event) => {
            if (readOnly) return;
            onChange(event.target.value);
            autoSizeFallbackTextarea(event.target);
          }}
          onBlur={() => onBlur?.()}
          onKeyDown={(event) => {
            if (onSubmit && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onSubmit();
            }
          }}
          className={cn(
            "min-h-(--sz-12rem) w-full resize-none bg-transparent px-3 pb-3 pt-2 font-mono text-sm leading-6 outline-none",
            contentClassName,
          )}
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative paperclip-mdxeditor-scope",
        bordered ? "rounded-md border border-border bg-transparent" : "bg-transparent",
        isDragOver && "ring-1 ring-primary/60 bg-accent/20",
        className,
      )}
      onKeyDownCapture={(e) => {
        if (readOnly) return;
        // Cmd/Ctrl+Enter to submit
        if (onSubmit && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          onSubmit();
          return;
        }

        // Mention keyboard handling
        if (mentionActive) {
          if (e.key === " " && mentionStateRef.current?.trigger === "skill") {
            mentionStateRef.current = null;
            skillEnterArmedRef.current = false;
            setMentionState(null);
            return;
          }
          // Escape always dismisses
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            mentionStateRef.current = null;
            skillEnterArmedRef.current = false;
            setMentionState(null);
            return;
          }
          // Arrow / Enter / Tab only when there are filtered results
          if (filteredMentions.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              e.stopPropagation();
              skillEnterArmedRef.current = mentionStateRef.current?.trigger === "skill";
              setMentionIndex((prev) => Math.min(prev + 1, filteredMentions.length - 1));
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              e.stopPropagation();
              skillEnterArmedRef.current = mentionStateRef.current?.trigger === "skill";
              setMentionIndex((prev) => Math.max(prev - 1, 0));
              return;
            }
            if (
              shouldAcceptAutocompleteKey(
                e.key,
                mentionStateRef.current?.trigger ?? null,
                skillEnterArmedRef.current,
              )
            ) {
              e.preventDefault();
              e.stopPropagation();
              selectMention(filteredMentions[mentionIndex]);
              return;
            }
          }
        }
      }}
      onDragEnter={(evt) => {
        if (readOnly) return;
        if (!canDropFile || !hasFilePayload(evt)) return;
        dragDepthRef.current += 1;
        setIsDragOver(true);
      }}
      onDragOver={(evt) => {
        if (readOnly) return;
        if (!canDropFile || !hasFilePayload(evt)) return;
        evt.preventDefault();
        evt.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        if (readOnly) return;
        if (!canDropFile) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDragOver(false);
      }}
      onDrop={(evt) => {
        if (readOnly) return;
        dragDepthRef.current = 0;
        setIsDragOver(false);
        if (!onDropFile) return;
        const files = evt.dataTransfer?.files;
        if (!files || files.length === 0) return;
        const allFiles = Array.from(files);
        const nonImageFiles = allFiles.filter(
          (f) => !f.type.startsWith("image/"),
        );
        if (nonImageFiles.length === 0) return;
        // If all dropped files are non-image, prevent default so MDXEditor
        // doesn't try to handle them. If mixed, let images flow through to
        // the image plugin and only handle the non-image files ourselves.
        if (nonImageFiles.length === allFiles.length) {
          evt.preventDefault();
          evt.stopPropagation();
        }
        for (const file of nonImageFiles) {
          void onDropFile(file);
        }
      }}
      onPasteCapture={handlePasteCapture}
    >
      <MarkdownEditorRichErrorBoundary onError={handleRichEditorError}>
        <MDXEditor
          ref={setEditorRef}
          markdown={editorValue}
          suppressHtmlProcessing
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={(next) => {
            if (readOnly) return;
            const echo = echoIgnoreMarkdownRef.current;
            recordTts("onChange", {
              len: next.length,
              echo: echo !== null && next === echo,
              preview: next.slice(0, 60),
            });
            if (echo !== null && next === echo) {
              echoIgnoreMarkdownRef.current = null;
              latestValueRef.current = next;
              return;
            }
            if (echo !== null) {
              echoIgnoreMarkdownRef.current = null;
            }

            if (initialChildOnChangeRef.current) {
              initialChildOnChangeRef.current = false;
              if (next === "" && editorValue !== "") {
                echoIgnoreMarkdownRef.current = editorValue;
                recordTts("setMarkdown", { origin: "initial-empty", len: editorValue.length });
                ref.current?.setMarkdown(editorValue);
                return;
              }
            }
            latestValueRef.current = next;
            onChange(next);
          }}
          onBlur={() => onBlur?.()}
          onError={(payload) => {
            handleRichEditorError(payload.error);
          }}
          className={cn("paperclip-mdxeditor", !bordered && "paperclip-mdxeditor--borderless")}
          contentEditableClassName={cn(
            "paperclip-mdxeditor-content focus:outline-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:list-item",
            contentClassName,
          )}
          additionalLexicalNodes={[MentionAwareLinkNode, mentionAwareLinkNodeReplacement]}
          plugins={plugins}
        />
      </MarkdownEditorRichErrorBoundary>

      {/* Mention dropdown — rendered via portal so it isn't clipped by overflow containers */}
      {mentionActive && filteredMentions.length > 0 && mentionMenuPosition &&
        createPortal(
          <div
            data-paperclip-floating-ui=""
            data-testid="mention-autocomplete-menu"
            className="pointer-events-auto fixed z-(--z-9999) min-w-(--sz-180px) max-w-(--sz-calc-15) max-h-(--sz-208px) overflow-y-auto rounded-md border border-border bg-popover shadow-md"
            style={{
              top: mentionMenuPosition.top,
              left: mentionMenuPosition.left,
              touchAction: "pan-y",
              WebkitOverflowScrolling: "touch",
            }}
          >
            {filteredMentions.map((option, i) => (
              <button
                key={option.id}
                type="button"
                tabIndex={-1}
                ref={(node) => {
                  autocompleteOptionRefs.current[i] = node;
                }}
                className={cn(
                  "flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left hover:bg-accent/50 transition-colors",
                  i === mentionIndex && "bg-accent",
                )}
                onPointerDown={(e) => {
                  // Touch is handled via onTouchStart/onTouchEnd so vertical scrolling
                  // isn't swallowed; only handle mouse/pen here.
                  if (e.pointerType === "touch") return;
                  handleAutocompletePress(e, option);
                }}
                onMouseDown={(e) => handleAutocompletePress(e, option)}
                onTouchStart={handleAutocompleteTouchStart}
                onTouchMove={handleAutocompleteTouchMove}
                onTouchEnd={(e) => handleAutocompleteTouchEnd(e, option)}
                onMouseEnter={() => {
                  if (mentionStateRef.current?.trigger === "skill") {
                    skillEnterArmedRef.current = true;
                  }
                  setMentionIndex(i);
                }}
              >
                {option.kind === "routine" ? (
                  <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : option.kind === "skill" ? (
                  <Boxes className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : option.kind === "issue" ? (
                  <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : option.kind === "project" && option.projectId ? (
                  <span
                    className="inline-flex h-2 w-2 rounded-full border border-border/50"
                    style={{ backgroundColor: option.projectColor ?? "var(--project-none)" }}
                  />
                ) : option.kind === "user" ? (
                  <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <AgentIcon
                    icon={option.agentIcon}
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  />
                )}
                {option.kind === "issue" && option.issueIdentifier ? (
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">
                      {option.issueIdentifier}
                    </span>
                    <span className="truncate">{issueMentionTitle(option)}</span>
                  </span>
                ) : (
                  <span className="truncate">
                    {option.kind === "skill" || option.kind === "routine"
                      ? slashCommandLabel(option)
                      : option.name}
                  </span>
                )}
                {option.kind === "issue" && (
                  <span className="ml-auto text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
                    Task
                  </span>
                )}
                {option.kind === "project" && option.projectId && (
                  <span className="ml-auto text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
                    Project
                  </span>
                )}
                {option.kind === "user" && (
                  <span className="ml-auto text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
                    User
                  </span>
                )}
                {option.kind === "skill" && (
                  <span className="ml-auto text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
                    Skill
                  </span>
                )}
                {option.kind === "routine" && (
                  <span className="ml-auto text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
                    Routine
                  </span>
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}

      {isDragOver && canDropFile && (
        <div
          className={cn(
            "pointer-events-none absolute inset-1 z-40 flex items-center justify-center rounded-md border border-dashed border-primary/80 bg-primary/10 text-xs font-medium text-primary",
            !bordered && "inset-0 rounded-sm",
          )}
        >
          Drop {onDropFile ? "file" : "image"} to upload
        </div>
      )}
      {uploadError && (
        <p className="px-3 pb-2 text-xs text-destructive">{uploadError}</p>
      )}

      {/* NEO-405/NEO-409 dictation logging panel — dev-only, gated behind
          ?ttsdebug=1 or localStorage["neo405-tts-debug"]="1". Never renders for
          normal users. Rendered via portal on document.body (see TtsDebugPanel)
          so it lives outside this editor tree and cannot perturb dictation.
          Instrumentation only; removed before promotion to live. */}
      {ttsDebug && ttsLogRef.current && <TtsDebugPanel log={ttsLogRef.current} />}
    </div>
  );
});
