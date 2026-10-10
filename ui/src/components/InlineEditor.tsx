import { useState, useRef, useEffect, useCallback, useId } from "react";
import { cn } from "../lib/utils";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "./MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { useDurableAutosave } from "../hooks/useDurableAutosave";
import { loadStructuredDraft, saveStructuredDraft } from "../lib/composer-draft";

type StoredInlineDraft = { version: 1; draft: string; base: string };
import { FoldCurtain } from "./FoldCurtain";

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
  /** When true, long display-mode markdown is clipped with a fade curtain that expands on click. */
  foldable?: boolean;
  /**
   * Optional host-resolved external object metadata. Forwarded to the read-mode
   * `MarkdownBody` so resolved URLs render with the inline status icon prefix.
   */
  externalReferences?: MarkdownExternalReferenceMap;
  /**
   * Mount the multiline editor already in edit mode, focused — for hosts whose
   * own affordance opens the editor (the description bubble's pencil, PAP-375).
   */
  defaultEditing?: boolean;
  /** Notified when the multiline editor swaps between display and edit mode. */
  onEditingChange?: (editing: boolean) => void;
  /**
   * Keep unsaved edits in browser storage under this key, so a reload or an
   * outage does not lose them. A stored edit is restored and saved on mount.
   */
  draftKey?: string;
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
  foldable = false,
  externalReferences,
  defaultEditing = false,
  onEditingChange,
  draftKey,
}: InlineEditorProps) {
  const [editing, setEditing] = useState(false);
  const [multilineEditing, setMultilineEditing] = useState(multiline && defaultEditing);
  const [multilineFocused, setMultilineFocused] = useState(false);
  const [draft, setDraft] = useState(value);
  const lastPropValueRef = useRef(value);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const markdownRef = useRef<MarkdownEditorRef>(null);
  const autosaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurCommitFrameRef = useRef<(() => void) | null>(null);
  const pendingFocusFrameRef = useRef<number | null>(null);
  const justEnteredEditRef = useRef(multiline && defaultEditing);
  const hasBeenFocusedRef = useRef(false);
  const autosave = useDurableAutosave<string>({
    sourceId: `inline-editor:${useId()}`,
    save: async (next) => {
      await onSave(next);
    },
  });
  const { markDirty, reset, run: runAutosave } = autosave;
  const autosaveState = autosave.status;

  // Unsaved edits are stored with the value they were based on, so a restored
  // edit never silently overwrites a newer server value.
  const storageKey = draftKey ? `paperclip:inline-draft:${draftKey}` : null;
  const clearStoredDraft = useCallback(() => {
    if (!storageKey) return;
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Unavailable storage holds nothing to clear.
    }
  }, [storageKey]);

  // Any path that lands the edit (blur, autosave, a resend after an outage)
  // updates `value`; the stored copy is then no longer needed.
  useEffect(() => {
    if (!storageKey) return;
    const stored = loadStructuredDraft<StoredInlineDraft | null>(storageKey, null);
    if (stored && typeof stored.draft === "string" && stored.draft.trim() === value.trim()) clearStoredDraft();
  }, [clearStoredDraft, storageKey, value]);

  const changeDraft = useCallback((next: string) => {
    setDraft(next);
    if (!storageKey) return;
    if (next.trim() === value.trim()) clearStoredDraft();
    else saveStructuredDraft(storageKey, { version: 1, draft: next, base: value } satisfies StoredInlineDraft);
  }, [clearStoredDraft, storageKey, value]);

  useEffect(() => {
    const previousValue = lastPropValueRef.current;
    lastPropValueRef.current = value;
    setDraft((currentDraft) => {
      if (multiline && multilineFocused && currentDraft !== previousValue) {
        return currentDraft;
      }
      return value;
    });
  }, [value, multiline, multilineFocused]);

  // An edit that never saved (reload, crash, outage) comes back. It saves on
  // its own only when the server value is still the one it was based on;
  // otherwise it waits in the editor for the user.
  const restoredDraftRef = useRef(false);
  useEffect(() => {
    if (restoredDraftRef.current || !storageKey) return;
    restoredDraftRef.current = true;
    const stored = loadStructuredDraft<StoredInlineDraft | null>(storageKey, null);
    if (!stored || stored.version !== 1 || typeof stored.draft !== "string" || typeof stored.base !== "string") return;
    if (stored.draft.trim() === value.trim()) {
      clearStoredDraft();
      return;
    }
    setDraft(stored.draft);
    if (multiline) {
      setMultilineEditing(true);
      onEditingChange?.(true);
    } else {
      setEditing(true);
    }
    if (stored.base === value) void runAutosave(stored.draft.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
      if (blurCommitFrameRef.current !== null) {
        blurCommitFrameRef.current();
        blurCommitFrameRef.current = null;
      }
      if (pendingFocusFrameRef.current !== null) {
        cancelAnimationFrame(pendingFocusFrameRef.current);
        pendingFocusFrameRef.current = null;
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
    if (!multilineEditing || !multiline) return;
    if (!justEnteredEditRef.current) return;
    justEnteredEditRef.current = false;
    if (pendingFocusFrameRef.current !== null) {
      cancelAnimationFrame(pendingFocusFrameRef.current);
    }
    pendingFocusFrameRef.current = requestAnimationFrame(() => {
      pendingFocusFrameRef.current = null;
      markdownRef.current?.focus();
    });
    return () => {
      if (pendingFocusFrameRef.current !== null) {
        cancelAnimationFrame(pendingFocusFrameRef.current);
        pendingFocusFrameRef.current = null;
      }
    };
  }, [multilineEditing, multiline]);

  // Once the editor has been focused at least once, it's blurred, and any
  // autosave has settled, swap back to the MarkdownBody preview so inline
  // issue refs render with status + quicklook.
  useEffect(() => {
    if (multilineFocused) {
      hasBeenFocusedRef.current = true;
      return;
    }
    if (!multiline || !multilineEditing) return;
    if (!hasBeenFocusedRef.current) return;
    // Waiting or failed saves keep the editor open, so the text stays visible.
    if (autosaveState !== "idle") return;
    hasBeenFocusedRef.current = false;
    setMultilineEditing(false);
    onEditingChange?.(false);
  }, [multiline, multilineEditing, multilineFocused, autosaveState, onEditingChange]);


  // A single-line edit that waited for the connection closes once it saves.
  useEffect(() => {
    if (multiline || !editing || autosaveState !== "saved") return;
    if (document.activeElement === inputRef.current) return;
    setEditing(false);
  }, [autosaveState, editing, multiline]);

  /** Save the draft if it changed. Never rejects; a failed save keeps the text. */
  const commit = useCallback(async (nextValue = draft) => {
    const valueToSave = nextValue.trim();
    const valueChanged = valueToSave !== value;
    const shouldSave = nullable
      ? valueChanged
      : Boolean(valueToSave && valueChanged);
    if (!shouldSave) {
      setDraft(value);
      if (draftKey) clearStoredDraft();
      if (!multiline) setEditing(false);
      return;
    }
    const result = await runAutosave(valueToSave);
    // A single-line edit stays open until it is saved, so its text is not lost.
    if (!multiline && result.kind === "saved") setEditing(false);
  }, [clearStoredDraft, draft, draftKey, multiline, nullable, runAutosave, value]);

  /** Multiline blur/submit: show autosave indicator when persisting */
  const finalizeMultilineBlurOrSubmit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed === value || (!trimmed && !nullable)) {
      reset();
    }
    void commit();
  }, [commit, draft, nullable, reset, value]);

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
      if (draftKey) clearStoredDraft();
      if (multiline) {
        setMultilineFocused(false);
        setMultilineEditing(false);
        onEditingChange?.(false);
        hasBeenFocusedRef.current = false;
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
      void commit(trimmed);
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
    };
  }, [autosaveState, commit, draft, markDirty, multiline, multilineFocused, nullable, reset, value]);

  if (multiline) {
    const previewValue = autosaveState === "saved" || autosaveState === "idle" ? draft : value;
    const hasValue = Boolean(previewValue.trim());
    const showEditor = multilineEditing || multilineFocused || !hasValue;

    if (!showEditor) {
      const enterEditMode = () => {
        if (multilineEditing) return;
        justEnteredEditRef.current = true;
        setMultilineEditing(true);
        onEditingChange?.(true);
      };
      return (
        <div
          className={cn(markdownPad, "rounded transition-colors hover:bg-accent/20")}
          onClick={(event) => {
            if (event.defaultPrevented) return;
            const target = event.target as HTMLElement | null;
            if (target && target.closest("a,button,[data-mention-kind],[data-radix-popper-content-wrapper]")) {
              return;
            }
            enterEditMode();
          }}
          onDragEnter={() => enterEditMode()}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            enterEditMode();
          }}
          role="textbox"
          aria-multiline="true"
          aria-label={placeholder}
          tabIndex={0}
        >
          {foldable ? (
            <FoldCurtain>
              <MarkdownBody
                className={cn("paperclip-edit-in-place-content", className)}
                externalReferences={externalReferences}
              >
                {previewValue}
              </MarkdownBody>
            </FoldCurtain>
          ) : (
            <MarkdownBody
              className={cn("paperclip-edit-in-place-content", className)}
              externalReferences={externalReferences}
            >
              {previewValue}
            </MarkdownBody>
          )}
        </div>
      );
    }

    return (
      <div
        className={cn(
          markdownPad,
          "rounded transition-colors",
          multilineFocused ? "bg-transparent" : "hover:bg-accent/20",
        )}
        onFocusCapture={(event) => {
          // Ignore focus events where the active element isn't actually inside
          // the wrapper (React 19 can emit a synthetic focus after a blur).
          const active = document.activeElement;
          if (!(active instanceof Node) || !event.currentTarget.contains(active)) return;
          cancelPendingBlurCommit();
          setMultilineFocused(true);
        }}
        onBlurCapture={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          if (pendingFocusFrameRef.current !== null) {
            cancelAnimationFrame(pendingFocusFrameRef.current);
            pendingFocusFrameRef.current = null;
          }
          scheduleBlurCommit(event.currentTarget);
        }}
        onKeyDown={handleKeyDown}
      >
        <MarkdownEditor
          ref={markdownRef}
          value={draft}
          onChange={changeDraft}
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
              "text-(length:--text-micro) transition-opacity duration-150",
              autosaveState === "error" ? "text-destructive" : "text-muted-foreground",
              autosaveState === "idle" ? "opacity-0" : "opacity-100",
            )}
            role={autosaveState === "error" ? "alert" : "status"}
          >
            {autosave.label ?? "Idle"}
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
          changeDraft(e.target.value);
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
