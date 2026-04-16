import { useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { defaultKeymap, historyKeymap, history } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";

interface ScriptEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: "javascript" | "python";
  className?: string;
}

function getTheme() {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return oneDark;
  }
  return EditorView.theme({
    "&": {
      backgroundColor: "transparent",
      fontSize: "13px",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    },
    ".cm-content": { padding: "12px 0" },
    ".cm-line": { paddingLeft: "12px", paddingRight: "12px" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "hsl(var(--muted-foreground))",
      fontSize: "12px",
    },
  });
}

export function ScriptEditor({ value, onChange, language, className }: ScriptEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Track whether we're updating from outside to avoid re-triggering onChange
  const externalUpdateRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const langExtension = language === "python" ? python() : javascript();

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle),
        langExtension,
        getTheme(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !externalUpdateRef.current) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Only re-create the editor when language changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // Sync external value changes without recreating the editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    externalUpdateRef.current = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
    externalUpdateRef.current = false;
  }, [value]);

  return (
    <div
      ref={containerRef}
      className={`min-h-[200px] rounded-md border border-input bg-background overflow-auto text-sm ${className ?? ""}`}
    />
  );
}
