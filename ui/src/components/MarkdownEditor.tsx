import {
  type ClipboardEvent,
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
import { buildAgentMentionHref, buildProjectMentionHref } from "@paperclipai/shared";
import { Boxes } from "lucide-react";
import { AgentIcon } from "./AgentIconPicker";
import { applyMentionChipDecoration, clearMentionChipDecoration, parseMentionChipHref } from "../lib/mention-chips";
import { MentionAwareLinkNode, mentionAwareLinkNodeReplacement } from "../lib/mention-aware-link-node";
import { mentionDeletionPlugin } from "../lib/mention-deletion";
import { looksLikeMarkdownPaste } from "../lib/markdownPaste";
import { normalizeMarkdown } from "../lib/normalize-markdown";
import { pasteNormalizationPlugin } from "../lib/paste-normalization";
import { cn } from "../lib/utils";
import { useEditorAutocomplete, type SkillCommandOption } from "../context/EditorAutocompleteContext";

/* ---- Mention types ---- */

export interface MentionOption {
  id: string;
  name: string;
  kind?: "agent" | "project";
  agentId?: string;
  agentIcon?: string | null;
  projectId?: string;
  projectColor?: string | null;
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
  bordered?: boolean;
  /** List of mentionable entities. Enables @-mention autocomplete. */
  mentions?: MentionOption[];
  /** Called on Cmd/Ctrl+Enter */
  onSubmit?: () => void;
}

export interface MarkdownEditorRef {
  focus: () => void;
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

function isRichEditorDomEmpty(
  editable: HTMLElement,
  expectedValue: string,
  placeholder?: string,
): boolean {
  const expectedText = expectedValue.trim();
  if (!expectedText) return false;

  const visibleText = (editable.textContent ?? "").trim();
  if (visibleText.length === 0) {
    return !Array.from(editable.childNodes).some((child) => hasMeaningfulEditorContent(child));
  }

  const normalizedPlaceholder = placeholder?.trim();
  if (
    normalizedPlaceholder
    && visibleText === normalizedPlaceholder
    && expectedText !== normalizedPlaceholder
  ) {
    return true;
  }

  return false;
}

function isSafeMarkdownLinkUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return true;
  return !/^(javascript|data|vbscript):/i.test(trimmed);
}

/* ---- Mention detection helpers ---- */

interface MentionState {
  trigger: "mention" | "skill";
  marker: "@" | "/";
  query: string;
  top: number;
  left: number;
  /** Viewport-relative coords for portal positioning */
  viewportTop: number;
  viewportLeft: number;
  textNode: Text;
  atPos: number;
  endPos: number;
}

type AutocompleteOption = MentionOption | SkillCommandOption;

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
  if (trigger === "skill" && /\s/.test(query)) return null;

  return {
    trigger: trigger ?? "mention",
    marker: marker ?? "@",
    query,
    atPos,
    endPos: offset,
  };
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

  // Get position relative to container
  const tempRange = document.createRange();
  tempRange.setStart(textNode, match.atPos);
  tempRange.setEnd(textNode, match.atPos + 1);
  const rect = tempRange.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  return {
    trigger: match.trigger,
    marker: match.marker,
    query: match.query,
    top: rect.bottom - containerRect.top,
    left: rect.left - containerRect.left,
    viewportTop: rect.bottom,
    viewportLeft: rect.left,
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
  anchor: Pick<MentionState, "viewportTop" | "viewportLeft">,
  viewport: MentionMenuViewport,
  menuSize: MentionMenuSize = { width: MENTION_MENU_WIDTH, height: MENTION_MENU_HEIGHT },
) {
  const minLeft = viewport.offsetLeft + MENTION_MENU_PADDING;
  const maxLeft = viewport.offsetLeft + viewport.width - menuSize.width;
  const minTop = viewport.offsetTop + MENTION_MENU_PADDING;
  const maxTop = viewport.offsetTop + viewport.height - menuSize.height;

  return {
    top: Math.max(minTop, Math.min(viewport.offsetTop + anchor.viewportTop + 4, maxTop)),
    left: Math.max(minLeft, Math.min(viewport.offsetLeft + anchor.viewportLeft, maxLeft)),
  };
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

function mentionMarkdown(option: MentionOption): string {
  if (option.kind === "project" && option.projectId) {
    return `[@${option.name}](${buildProjectMentionHref(option.projectId, option.projectColor ?? null)}) `;
  }
  const agentId = option.agentId ?? option.id.replace(/^agent:/, "");
  return `[@${option.name}](${buildAgentMentionHref(agentId, option.agentIcon ?? null)}) `;
}

function skillMarkdown(option: SkillCommandOption): string {
  return `[/${option.slug}](${option.href}) `;
}

function autocompleteMarkdown(option: AutocompleteOption): string {
  return option.kind === "skill" ? skillMarkdown(option) : mentionMarkdown(option);
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

  if (option.kind === "project" && option.projectId) {
    return parsed.kind === "project" && parsed.projectId === option.projectId;
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
  bordered = true,
  mentions,
  onSubmit,
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
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [richEditorError, setRichEditorError] = useState<string | null>(null);
  const dragDepthRef = useRef(0);

  // Stable ref for imageUploadHandler so plugins don't recreate on every render
  const imageUploadHandlerRef = useRef(imageUploadHandler);
  imageUploadHandlerRef.current = imageUploadHandler;

  // Mention state (ref kept in sync so callbacks always see the latest value)
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const mentionStateRef = useRef<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
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
      instance.setMarkdown(valueRef.current);
      latestValueRef.current = valueRef.current;
    }
  }, []);

  const filteredMentions = useMemo<AutocompleteOption[]>(() => {
    if (!mentionState) return [];
    const q = mentionState.query.trim().toLowerCase();
    if (mentionState.trigger === "skill") {
      return slashCommands
        .filter((command) => {
          if (!q) return true;
          return command.aliases.some((alias) => alias.toLowerCase().includes(q));
        })
        .slice(0, 8);
    }
    if (!mentions) return [];
    return mentions.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 8);
  }, [mentionState, mentions, slashCommands]);

  useImperativeHandle(forwardedRef, () => ({
    focus: () => {
      if (richEditorError) {
        fallbackTextareaRef.current?.focus();
        return;
      }
      ref.current?.focus(undefined, { defaultSelection: "rootEnd" });
    },
  }), [richEditorError]);

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

  useEffect(() => {
    if (editorValue !== latestValueRef.current) {
      if (ref.current) {
        // Pair with onChange echo suppression (echoIgnoreMarkdownRef).
        echoIgnoreMarkdownRef.current = editorValue;
        ref.current.setMarkdown(editorValue);
        latestValueRef.current = editorValue;
      }
    }
  }, [editorValue]);

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

      if (parsed.kind === "skill") {
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
    [decorateProjectMentions, onChange],
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

  function hasFilePayload(evt: DragEvent<HTMLDivElement>) {
    return Array.from(evt.dataTransfer?.types ?? []).includes("Files");
  }

  const canDropImage = Boolean(imageUploadHandler);
  const canDropFile = Boolean(imageUploadHandler || onDropFile);
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
          onChange={(event) => {
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
            "min-h-[12rem] w-full resize-none bg-transparent px-3 pb-3 pt-2 font-mono text-sm leading-6 outline-none",
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
        if (!canDropFile || !hasFilePayload(evt)) return;
        dragDepthRef.current += 1;
        setIsDragOver(true);
      }}
      onDragOver={(evt) => {
        if (!canDropFile || !hasFilePayload(evt)) return;
        evt.preventDefault();
        evt.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        if (!canDropFile) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDragOver(false);
      }}
      onDrop={(evt) => {
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
      <MDXEditor
        ref={setEditorRef}
        markdown={editorValue}
        placeholder={placeholder}
        onChange={(next) => {
          const echo = echoIgnoreMarkdownRef.current;
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
              ref.current?.setMarkdown(editorValue);
              return;
            }
          }
          latestValueRef.current = next;
          onChange(next);
        }}
        onBlur={() => onBlur?.()}
        onError={(payload) => {
          setRichEditorError(payload.error);
        }}
        className={cn("paperclip-mdxeditor", !bordered && "paperclip-mdxeditor--borderless")}
        contentEditableClassName={cn(
          "paperclip-mdxeditor-content focus:outline-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:list-item",
          contentClassName,
        )}
        additionalLexicalNodes={[MentionAwareLinkNode, mentionAwareLinkNodeReplacement]}
        plugins={plugins}
      />

      {/* Mention dropdown — rendered via portal so it isn't clipped by overflow containers */}
      {mentionActive && filteredMentions.length > 0 &&
        createPortal(
          <div
            className="fixed z-[9999] min-w-[180px] max-w-[calc(100vw-16px)] max-h-[200px] overflow-y-auto rounded-md border border-border bg-popover shadow-md"
            style={mentionMenuPosition ?? undefined}
          >
            {filteredMentions.map((option, i) => (
              <button
                key={option.id}
                type="button"
                className={cn(
                  "flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left hover:bg-accent/50 transition-colors",
                  i === mentionIndex && "bg-accent",
                )}
                onPointerDown={(e) => handleAutocompletePress(e, option)}
                onMouseDown={(e) => handleAutocompletePress(e, option)}
                onTouchStart={(e) => handleAutocompletePress(e, option)}
                onMouseEnter={() => {
                  if (mentionStateRef.current?.trigger === "skill") {
                    skillEnterArmedRef.current = true;
                  }
                  setMentionIndex(i);
                }}
              >
                {option.kind === "skill" ? (
                  <Boxes className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : option.kind === "project" && option.projectId ? (
                  <span
                    className="inline-flex h-2 w-2 rounded-full border border-border/50"
                    style={{ backgroundColor: option.projectColor ?? "#64748b" }}
                  />
                ) : (
                  <AgentIcon
                    icon={option.agentIcon}
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  />
                )}
                <span>{option.kind === "skill" ? `/${option.slug}` : option.name}</span>
                {option.kind === "project" && option.projectId && (
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                    Project
                  </span>
                )}
                {option.kind === "skill" && (
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                    Skill
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
    </div>
  );
});
