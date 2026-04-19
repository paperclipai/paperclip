import { useMemo, useCallback, useRef, useImperativeHandle, forwardRef } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { useTheme } from "../context/ThemeContext";
import { cn } from "../lib/utils";
import { paperclipDarkTheme, paperclipLightTheme } from "./codemirror-paperclip-theme";

export interface MarkdownSourceEditorRef {
  focus: () => void;
}

interface MarkdownSourceEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Min-height CSS value for the editor area. */
  minHeight?: string;
  /** Called on Cmd/Ctrl+Enter. */
  onSubmit?: () => void;
  readOnly?: boolean;
}

export const MarkdownSourceEditor = forwardRef<MarkdownSourceEditorRef, MarkdownSourceEditorProps>(
  function MarkdownSourceEditor(
    { value, onChange, placeholder, className, minHeight = "120px", onSubmit, readOnly = false },
    ref,
  ) {
    const { theme } = useTheme();
    const cmRef = useRef<ReactCodeMirrorRef>(null);

    useImperativeHandle(ref, () => ({
      focus: () => cmRef.current?.view?.focus(),
    }));

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && onSubmit) {
          e.preventDefault();
          onSubmit();
        }
      },
      [onSubmit],
    );

    const extensions = useMemo(() => {
      const exts = [markdown(), EditorView.lineWrapping, theme === "dark" ? paperclipDarkTheme : paperclipLightTheme];
      return exts;
    }, [theme]);

    return (
      <div
        className={cn(
          "rounded-md border border-border bg-background font-mono text-sm transition-colors focus-within:ring-1 focus-within:ring-ring",
          className,
        )}
        onKeyDown={handleKeyDown}
      >
        <CodeMirror
          ref={cmRef}
          value={value}
          onChange={onChange}
          readOnly={readOnly}
          placeholder={placeholder}
          extensions={extensions}
          theme={theme === "dark" ? "dark" : "light"}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            indentOnInput: true,
            bracketMatching: true,
            closeBrackets: true,
          }}
          style={{ minHeight }}
        />
      </div>
    );
  },
);
