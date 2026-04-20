import { useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { Table } from "@lezer/markdown";
import { EditorView } from "@codemirror/view";
import { useTheme } from "../context/ThemeContext";
import { cn } from "../lib/utils";
import { MarkdownBody } from "./MarkdownBody";

/** Return the lowercase file extension for a filename. */
function getFileExt(filename: string): string | undefined {
  return filename.split(".").pop()?.toLowerCase();
}

/** Map file extensions to CodeMirror language extensions. */
function getLanguageExtension(ext: string | undefined) {
  switch (ext) {
    case "js":
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "json":
      return json();
    case "md":
    case "mdx":
      return markdown({ extensions: [Table] });
    default:
      return null;
  }
}

/** Whether the file is a CSV (or TSV) that benefits from visual line mode. */
function isCsvLike(ext: string | undefined): boolean {
  return ext === "csv" || ext === "tsv";
}

/** Whether the file is a markdown file that supports preview. */
function isMarkdown(ext: string | undefined): boolean {
  return ext === "md" || ext === "mdx";
}

interface FileEditorProps {
  /** File name or path — used to detect language for syntax highlighting. */
  filename: string;
  /** Current editor content. */
  value: string;
  /** Called when the user edits the content. */
  onChange?: (value: string) => void;
  /** If true, the editor is read-only. */
  readOnly?: boolean;
  /** Optional CSS class name applied to the wrapper div. */
  className?: string;
}

export function FileEditor({ filename, value, onChange, readOnly = false, className }: FileEditorProps) {
  const { theme } = useTheme();
  const ext = getFileExt(filename);
  const [showPreview, setShowPreview] = useState(false);

  const extensions = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exts: any[] = [];
    const lang = getLanguageExtension(ext);
    if (lang) exts.push(lang);
    // CSV/TSV: enable line wrapping so columns stay visible without scrolling
    if (isCsvLike(ext)) {
      exts.push(EditorView.lineWrapping);
    }
    return exts;
  }, [ext]);

  const canPreview = isMarkdown(ext);

  return (
    <div className={cn("overflow-hidden rounded-md border", className)}>
      {/* Toolbar — only shown for markdown files */}
      {canPreview && (
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs">
          <button
            type="button"
            className={cn(
              "rounded px-2 py-0.5 transition-colors",
              !showPreview
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setShowPreview(false)}
          >
            Editor
          </button>
          <button
            type="button"
            className={cn(
              "rounded px-2 py-0.5 transition-colors",
              showPreview
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setShowPreview(true)}
          >
            Preview
          </button>
        </div>
      )}

      {/* Markdown preview pane */}
      {canPreview && showPreview ? (
        <div className="max-h-[600px] overflow-auto p-4">
          <MarkdownBody>{value}</MarkdownBody>
        </div>
      ) : (
        <CodeMirror
          value={value}
          onChange={onChange}
          readOnly={readOnly}
          theme={theme === "dark" ? "dark" : "light"}
          extensions={extensions}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: !readOnly,
          }}
        />
      )}
    </div>
  );
}
