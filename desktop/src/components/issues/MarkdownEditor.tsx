import { useState, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

type EditorTab = "write" | "preview";

function renderMarkdown(text: string): string {
  let html = text
    // Escape HTML
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Headers: # heading
    .replace(/^### (.+)$/gm, "<h5 style='font-size:14px;font-weight:600;margin:8px 0 4px;'>$1</h5>")
    .replace(/^## (.+)$/gm, "<h4 style='font-size:15px;font-weight:600;margin:8px 0 4px;'>$1</h4>")
    .replace(/^# (.+)$/gm, "<h3 style='font-size:16px;font-weight:600;margin:8px 0 4px;'>$1</h3>")
    // Bold: **text**
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic: *text*
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Inline code: `code`
    .replace(/`([^`]+)`/g, "<code style='background:var(--bg-muted);padding:1px 4px;border-radius:3px;font-size:12px;font-family:var(--font-mono)'>$1</code>")
    // List items: - item
    .replace(/^- (.+)$/gm, "<li style='margin-left:16px;list-style:disc;'>$1</li>")
    // Paragraphs (blank lines)
    .replace(/\n\n/g, "</p><p style='margin:8px 0;'>")
    // Single newlines
    .replace(/\n/g, "<br />");

  html = `<p style='margin:8px 0;'>${html}</p>`;
  return html;
}

export function MarkdownEditor({ value, onChange, placeholder }: MarkdownEditorProps) {
  const [tab, setTab] = useState<EditorTab>("write");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const insertSyntax = useCallback(
    (before: string, after: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selected = value.slice(start, end);
      const newValue = value.slice(0, start) + before + selected + after + value.slice(end);
      onChange(newValue);

      // Restore cursor position after React re-render
      requestAnimationFrame(() => {
        textarea.focus();
        const cursorPos = selected ? start + before.length + selected.length + after.length : start + before.length;
        textarea.setSelectionRange(cursorPos, cursorPos);
      });
    },
    [value, onChange],
  );

  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ background: "var(--card-bg)", borderColor: "var(--input-border)" }}
    >
      {/* Toolbar + tabs */}
      <div
        className="flex items-center justify-between border-b px-3 py-1.5"
        style={{ borderColor: "var(--input-border)", background: "var(--bg-muted)" }}
      >
        {/* Tabs */}
        <div className="flex gap-0">
          {(["write", "preview"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn("px-3 py-1 text-[12px] capitalize rounded-md")}
              style={{
                color: tab === t ? "var(--fg)" : "var(--fg-muted)",
                fontWeight: tab === t ? 500 : 400,
                background: tab === t ? "var(--card-bg)" : "transparent",
                border: "none",
                fontFamily: "var(--font-body)",
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Formatting buttons (only in write mode) */}
        {tab === "write" && (
          <div className="flex gap-1">
            <button
              onClick={() => insertSyntax("**", "**")}
              className="flex h-6 w-6 items-center justify-center rounded text-[12px] font-bold hover:bg-[var(--bg-subtle)]"
              style={{ color: "var(--fg-muted)", border: "none", background: "none" }}
              title="Bold"
            >
              B
            </button>
            <button
              onClick={() => insertSyntax("*", "*")}
              className="flex h-6 w-6 items-center justify-center rounded text-[12px] italic hover:bg-[var(--bg-subtle)]"
              style={{ color: "var(--fg-muted)", border: "none", background: "none" }}
              title="Italic"
            >
              I
            </button>
            <button
              onClick={() => insertSyntax("`", "`")}
              className="flex h-6 w-6 items-center justify-center rounded text-[11px] hover:bg-[var(--bg-subtle)]"
              style={{ color: "var(--fg-muted)", border: "none", background: "none", fontFamily: "var(--font-mono)" }}
              title="Code"
            >
              {"</>"}
            </button>
          </div>
        )}
      </div>

      {/* Write tab */}
      {tab === "write" && (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={6}
          className="w-full resize-none border-none p-3 text-sm outline-none"
          style={{
            background: "var(--card-bg)",
            color: "var(--fg)",
            fontFamily: "var(--font-mono)",
            fontSize: "13px",
            lineHeight: "1.6",
          }}
        />
      )}

      {/* Preview tab */}
      {tab === "preview" && (
        <div
          className="min-h-[150px] p-3 text-sm leading-relaxed"
          style={{ color: "var(--fg-secondary)" }}
        >
          {value ? (
            <div dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }} />
          ) : (
            <span style={{ color: "var(--fg-muted)" }}>Nothing to preview.</span>
          )}
        </div>
      )}
    </div>
  );
}
