import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  dropCursor,
} from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
} from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  foldGutter,
  bracketMatching,
  indentOnInput,
  foldKeymap,
} from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { searchKeymap, search } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Extension } from "@codemirror/state";

// File size threshold (in bytes) above which the editor switches to read-only mode.
const LARGE_FILE_THRESHOLD = 500_000; // 500 KB

// Files above this size are not displayed at all (binary/very-large fallback UI).
const BINARY_WARN_THRESHOLD = 1_000_000; // 1 MB

// Ratio of non-printable characters above which content is considered binary.
const BINARY_CHAR_RATIO_THRESHOLD = 0.1;

// Number of leading bytes sampled when detecting binary content.
const BINARY_SAMPLE_SIZE = 1_000;

/**
 * Detect if content looks like binary data.
 *
 * Heuristics used (in order):
 * 1. Presence of null bytes (U+0000).
 * 2. High ratio of non-printable characters in the first BINARY_SAMPLE_SIZE chars.
 *    Control characters TAB (9), LF (10), VT (11), FF (12), CR (13) are allowed;
 *    everything else below 0x20 is treated as non-printable.
 */
function isBinaryContent(content: string): boolean {
  if (content.includes("\0")) return true;
  if (content.length === 0) return false;

  const sample = content.slice(0, BINARY_SAMPLE_SIZE);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32)) nonPrintable++;
  }
  return nonPrintable / sample.length > BINARY_CHAR_RATIO_THRESHOLD;
}

/**
 * Derive a CodeMirror language extension from the file path's extension.
 * Returns `null` for unknown/unsupported extensions.
 */
function getLanguageExtension(filePath: string): Extension | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "html":
    case "htm":
      return html();
    case "css":
    case "scss":
    case "sass":
    case "less":
      return css();
    case "json":
    case "jsonc":
      return json();
    case "md":
    case "mdx":
    case "markdown":
      return markdown();
    case "py":
    case "pyw":
      return python();
    default:
      return null;
  }
}

export interface CodeMirrorEditorHandle {
  undo: () => void;
  redo: () => void;
}

export interface CodeMirrorEditorProps {
  /** File path — used to determine syntax highlighting language. */
  filePath: string;
  /** Current file content (controlled). */
  content: string;
  /** Called when the user edits the buffer. NOT called on programmatic content updates. */
  onChange?: (value: string) => void;
  /** Called when Ctrl+S / Cmd+S is pressed. */
  onSave?: () => void;
  /** Force read-only mode (also auto-enabled for large or binary files). */
  readOnly?: boolean;
  /** Tab size in spaces. Defaults to 2. */
  tabSize?: number;
  /** Apply dark (One Dark) theme. Defaults to true. */
  dark?: boolean;
  /** Enable word wrapping. Defaults to false. */
  wordWrap?: boolean;
}

/**
 * CodeMirror 6 editor wrapper.
 *
 * Features:
 * - Syntax highlighting for JS/TS/JSX/TSX, HTML, CSS/SCSS, JSON, Markdown, Python
 * - Line numbers, code folding, bracket matching
 * - Search/replace panel via Ctrl+F
 * - Save shortcut via Ctrl+S / Cmd+S (calls `onSave`)
 * - Undo/redo via ref handle or Ctrl+Z / Ctrl+Shift+Z
 * - Auto read-only for binary or files larger than LARGE_FILE_THRESHOLD
 * - Fallback UI for binary files or files above BINARY_WARN_THRESHOLD
 */
export const CodeMirrorEditor = forwardRef<CodeMirrorEditorHandle, CodeMirrorEditorProps>(
  function CodeMirrorEditor(
    { filePath, content, onChange, onSave, readOnly = false, tabSize = 2, dark = true, wordWrap = false },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);

    // Compartments allow individual extensions to be reconfigured without
    // destroying and recreating the entire editor view.
    const readOnlyCompartment = useRef(new Compartment());
    const tabSizeCompartment = useRef(new Compartment());
    const languageCompartment = useRef(new Compartment());
    const wrapCompartment = useRef(new Compartment());
    const themeCompartment = useRef(new Compartment());

    // Track whether a programmatic content update is in progress so the
    // updateListener can suppress the onChange callback for those dispatches.
    const isProgrammaticUpdate = useRef(false);

    // Stable refs for callbacks — avoids editor recreation when they change.
    const onChangeRef = useRef(onChange);
    const onSaveRef = useRef(onSave);
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;

    // Expose undo/redo via ref
    useImperativeHandle(ref, () => ({
      undo: () => { if (viewRef.current) undo(viewRef.current); },
      redo: () => { if (viewRef.current) redo(viewRef.current); },
    }));

    const isLargeFile = content.length > LARGE_FILE_THRESHOLD;
    const isBinary = isBinaryContent(content);
    const effectiveReadOnly = readOnly || isLargeFile || isBinary;

    // Show a hard fallback for files that cannot be rendered at all.
    if (isBinary || content.length > BINARY_WARN_THRESHOLD) {
      return (
        <div className="flex flex-col items-center justify-center flex-1 gap-2 text-center p-4 text-muted-foreground">
          <p className="text-sm font-medium">Binary or very large file</p>
          <p className="text-xs opacity-70">
            This file cannot be displayed in the editor.
          </p>
        </div>
      );
    }

    return (
      <EditorMount
        containerRef={containerRef}
        viewRef={viewRef}
        readOnlyCompartment={readOnlyCompartment}
        tabSizeCompartment={tabSizeCompartment}
        languageCompartment={languageCompartment}
        wrapCompartment={wrapCompartment}
        themeCompartment={themeCompartment}
        isProgrammaticUpdate={isProgrammaticUpdate}
        onChangeRef={onChangeRef}
        onSaveRef={onSaveRef}
        filePath={filePath}
        content={content}
        effectiveReadOnly={effectiveReadOnly}
        tabSize={tabSize}
        dark={dark}
        isLargeFile={isLargeFile}
        wordWrap={wordWrap}
      />
    );
  },
);

// ---------------------------------------------------------------------------
// Internal: EditorMount
// ---------------------------------------------------------------------------
// Separated so that all hooks always run in the same component regardless of
// the binary/large-file early-return above. React rules prohibit calling hooks
// after a conditional return, so we delegate the imperative editor lifecycle
// to this sub-component which is only rendered when the editor should appear.
// ---------------------------------------------------------------------------

interface EditorMountProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  viewRef: React.MutableRefObject<EditorView | null>;
  readOnlyCompartment: React.MutableRefObject<Compartment>;
  tabSizeCompartment: React.MutableRefObject<Compartment>;
  languageCompartment: React.MutableRefObject<Compartment>;
  wrapCompartment: React.MutableRefObject<Compartment>;
  themeCompartment: React.MutableRefObject<Compartment>;
  isProgrammaticUpdate: React.MutableRefObject<boolean>;
  onChangeRef: React.MutableRefObject<((value: string) => void) | undefined>;
  onSaveRef: React.MutableRefObject<(() => void) | undefined>;
  filePath: string;
  content: string;
  effectiveReadOnly: boolean;
  tabSize: number;
  dark: boolean;
  isLargeFile: boolean;
  wordWrap: boolean;
}

function EditorMount({
  containerRef,
  viewRef,
  readOnlyCompartment,
  tabSizeCompartment,
  languageCompartment,
  wrapCompartment,
  themeCompartment,
  isProgrammaticUpdate,
  onChangeRef,
  onSaveRef,
  filePath,
  content,
  effectiveReadOnly,
  tabSize,
  dark,
  isLargeFile,
  wordWrap,
}: EditorMountProps) {
  // Mount the editor once on initial render.
  useEffect(() => {
    if (!containerRef.current) return;

    const langExt = getLanguageExtension(filePath);

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      dropCursor(),
      foldGutter(),
      bracketMatching(),
      indentOnInput(),
      history(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      search({ top: true }),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...searchKeymap,
        indentWithTab,
        {
          key: "Mod-s",
          run: () => {
            onSaveRef.current?.();
            return true;
          },
        },
      ]),
      readOnlyCompartment.current.of(EditorState.readOnly.of(effectiveReadOnly)),
      tabSizeCompartment.current.of(EditorState.tabSize.of(tabSize)),
      languageCompartment.current.of(langExt ? [langExt] : []),
      wrapCompartment.current.of(wordWrap ? EditorView.lineWrapping : []),
      themeCompartment.current.of(dark ? [oneDark] : []),
      EditorView.theme({
        "&": {
          height: "100%",
          fontSize: "13px",
        },
        ".cm-scroller": {
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          overflow: "auto",
        },
        ".cm-content": {
          padding: "8px 0",
          minHeight: "100%",
        },
        ".cm-gutters": {
          border: "none",
          borderRight:
            "1px solid var(--cm-gutter-border, rgba(128,128,128,0.2))",
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !isProgrammaticUpdate.current) {
          onChangeRef.current?.(update.state.doc.toString());
        }
      }),
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Mount once — subsequent prop changes are handled by effects below.

  // Sync content when it changes from outside (e.g. a new file is loaded).
  // We suppress onChange during this dispatch to avoid a redundant state cycle.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentDoc = view.state.doc.toString();
    if (currentDoc !== content) {
      isProgrammaticUpdate.current = true;
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: content },
      });
      isProgrammaticUpdate.current = false;
    }
  }, [content, isProgrammaticUpdate, viewRef]);

  // Reconfigure read-only state.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        EditorState.readOnly.of(effectiveReadOnly),
      ),
    });
  }, [effectiveReadOnly, readOnlyCompartment, viewRef]);

  // Reconfigure tab size.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: tabSizeCompartment.current.reconfigure(
        EditorState.tabSize.of(tabSize),
      ),
    });
  }, [tabSize, tabSizeCompartment, viewRef]);

  // Reconfigure syntax highlighting when the file path changes.
  useEffect(() => {
    const langExt = getLanguageExtension(filePath);
    viewRef.current?.dispatch({
      effects: languageCompartment.current.reconfigure(
        langExt ? [langExt] : [],
      ),
    });
  }, [filePath, languageCompartment, viewRef]);

  // Reconfigure word wrap.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapCompartment.current.reconfigure(
        wordWrap ? EditorView.lineWrapping : [],
      ),
    });
  }, [wordWrap, wrapCompartment, viewRef]);

  // Reconfigure dark/light theme.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.current.reconfigure(
        dark ? [oneDark] : [],
      ),
    });
  }, [dark, themeCompartment, viewRef]);

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full">
      {isLargeFile && (
        <div className="px-3 py-1 text-xs text-muted-foreground border-b border-border bg-accent/40">
          Large file — editor is read-only (
          {(content.length / 1024).toFixed(0)} KB)
        </div>
      )}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden h-full [&_.cm-editor]:h-full [&_.cm-editor]:outline-none"
      />
    </div>
  );
}
