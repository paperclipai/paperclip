import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "../lib/utils";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { useAutosaveIndicator } from "../hooks/useAutosaveIndicator";

interface InlineEditorProps {
  value: string;
  onSave: (value: string) => void | Promise<unknown>;
  as?: "h1" | "h2" | "p" | "span";
  className?: string;
  placeholder?: string;
  multiline?: boolean;
  imageUploadHandler?: (file: File) => Promise<string>;
  /** Called when a non-image file is dropped onto the editor. */
  onDropFile?: (file: File) => Promise<void>;
  mentions?: MentionOption[];
  nullable?: boolean;
}

/** Shared padding so display and edit modes occupy the exact same box. */
const pad = "px-1 -mx-1";
const markdownPad = "px-1";
const AUTOSAVE_DEBOUNCE_MS = 900;

export function queueContainedBlurCommit(container: HTMLDivElement, onCommit: () => void) {
  let frameId = requestAnimationFrame(() => {
    frameId = requestAnimationFrame(() => {
      frameId = 0;
      const active = document.activeElement;
      if (active instanceof Node && container.contains(active)) return;
      onCommit();
    });
  });

  return () => {
    if (frameId === 0) return;
    cancelAnimationFrame(frameId);
    frameId = 0;
  };
}

export function InlineEditor({
  value,
  onSave,
  as: Tag = "span",
  className,
  placeholder = "Click to edit...",
  multiline = false,
  nullable = false,
  imageUploadHandler,
  onDropFile,
  mentions,
}: InlineEditorProps) {
  const [editing, setEditing] = useState(false);
  const [multilineFocused, setMultilineFocused] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const markdownRef = useRef<MarkdownEditorRef>(null);
  const autosaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurCommitFrameRef = useRef<(() => void) | null>(null);
  const {
    state: autosaveState,
    markDirty,
    reset,
    runSave,
  } = useAutosaveIndicator();

  useEffect(() => {
    if (multiline && multilineFocused) return;
    setDraft(value);
  }, [value, multiline, multilineFocused]);

  useEffect(() => {
    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
      if (blurCommitFrameRef.current !== null) {
        blurCommitFrameRef.current();
        blurCommitFrameRef.current = null;
      }
    };
  }, []);

  const autoSize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
      if (inputRef.current instanceof HTMLTextAreaElement) {
        autoSize(inputRef.current);
      }
    }
  }, [editing, autoSize]);

  useEffect(() => {
    if (!editing || !multiline) return;
    const frame = requestAnimationFrame(() => {
      markdownRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [editing, multiline]);

  const commit = useCallback(async (nextValue = draft) => {
    const valueToSave = nextValue.trim();
    const valueChanged = valueToSave !== value;
    const shouldSave = nullable
      ? valueChanged
      : Boolean(valueToSave && valueChanged);
    if (shouldSave) {
      await Promise.resolve(onSave(valueToSave));
    } else {
      setDraft(value);
    }
    if (!multiline) {
      setEditing(false);
    }
  }, [draft, multiline, nullable, onSave, value]);

  /** Multiline blur/submit: show autosave indicator when persisting */
  const finalizeMultilineBlurOrSubmit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed === value) {
      reset();
      void commit();
      return;
    }
    if (!trimmed && !nullable) {
      reset();
      void commit();
      return;
    }
    void runSave(() => commit());
  }, [commit, draft, nullable, reset, runSave, value]);

  const cancelPendingBlurCommit = useCallback(() => {
    if (blurCommitFrameRef.current === null) return;
    blurCommitFrameRef.current();
    blurCommitFrameRef.current = null;
  }, []);

  const scheduleBlurCommit = useCallback((container: HTMLDivElement) => {
    cancelPendingBlurCommit();
    blurCommitFrameRef.current = queueContainedBlurCommit(container, () => {
      blurCommitFrameRef.current = null;
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
      setMultilineFocused(false);
      finalizeMultilineBlurOrSubmit();
    });
  }, [cancelPendingBlurCommit, finalizeMultilineBlurOrSubmit]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      void commit();
    }
    if (e.key === "Escape") {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
      reset();
      setDraft(value);
      if (multiline) {
        setMultilineFocused(false);
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      } else {
        setEditing(false);
      }
    }
  }

  useEffect(() => {
    if (!multiline) return;
    if (!multilineFocused) return;
    const trimmed = draft.trim();
    // Nullable: empty draft can still be a real edit (clearing); only skip debounce when unchanged or empty is invalid.
    if (trimmed === value || (!trimmed && !nullable)) {
      if (autosaveState !== "saved") {
        reset();
      }
      return;
    }
    markDirty();
    if (autosaveDebounceRef.current) {
      clearTimeout(autosaveDebounceRef.current);
    }
    autosaveDebounceRef.current = setTimeout(() => {
      void runSave(() => commit(trimmed));
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
    };
  }, [autosaveState, commit, draft, markDirty, multiline, multilineFocused, nullable, reset, runSave, value]);

  if (multiline) {
    return (
      <div
        className={cn(
          markdownPad,
          "rounded transition-colors",
          multilineFocused ? "bg-transparent" : "hover:bg-accent/20",
        )}
        onFocusCapture={() => {
          cancelPendingBlurCommit();
          setMultilineFocused(true);
        }}
        onBlurCapture={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          scheduleBlurCommit(event.currentTarget);
        }}
        onKeyDown={handleKeyDown}
      >
        <MarkdownEditor
          ref={markdownRef}
          value={draft}
          onChange={setDraft}
          placeholder={placeholder}
          bordered={false}
          className="bg-transparent"
          contentClassName={cn("paperclip-edit-in-place-content", className)}
          imageUploadHandler={imageUploadHandler}
          onDropFile={onDropFile}
          mentions={mentions}
          onSubmit={() => {
            finalizeMultilineBlurOrSubmit();
          }}
        />
        <div className="flex min-h-4 items-center justify-end pr-1">
          <span
            className={cn(
              "text-[11px] transition-opacity duration-150",
              autosaveState === "error" ? "text-destructive" : "text-muted-foreground",
              autosaveState === "idle" ? "opacity-0" : "opacity-100",
            )}
          >
            {autosaveState === "saving"
              ? "Autosaving..."
              : autosaveState === "saved"
                ? "Saved"
                : autosaveState === "error"
                  ? "Could not save"
                  : "Idle"}
          </span>
        </div>
      </div>
    );
  }

  if (editing) {

    return (
      <textarea
        ref={inputRef}
        value={draft}
        rows={1}
        onChange={(e) => {
          setDraft(e.target.value);
          autoSize(e.target);
        }}
        onBlur={() => {
          void commit();
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          "w-full bg-transparent rounded outline-none resize-none overflow-hidden",
          pad,
          className
        )}
      />
    );
  }

  // Use div instead of Tag when rendering markdown to avoid invalid nesting
  // (e.g. <p> cannot contain the <div>/<p> elements that markdown produces)
  const DisplayTag = value && multiline ? "div" : Tag;

  return (
    <DisplayTag
      className={cn(
        "cursor-pointer rounded hover:bg-accent/50 transition-colors overflow-hidden",
        pad,
        !value && "text-muted-foreground italic",
        className,
      )}
      onClick={() => setEditing(true)}
    >
      {value || placeholder}
    </DisplayTag>
  );
}
