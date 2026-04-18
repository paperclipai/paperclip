import {
  forwardRef,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/utils";
import type { MarkdownEditorProps, MarkdownEditorRef } from "./MarkdownEditor.shared";

export {
  computeMentionMenuPosition,
  findMentionMatch,
  type MarkdownEditorProps,
  type MarkdownEditorRef,
  type MentionOption,
} from "./MarkdownEditor.shared";

type MarkdownEditorModule = typeof import("./MarkdownEditorImpl");
type MarkdownEditorComponent = MarkdownEditorModule["default"];

let markdownEditorModulePromise: Promise<MarkdownEditorModule> | null = null;

function loadMarkdownEditor() {
  if (!markdownEditorModulePromise) {
    markdownEditorModulePromise = import("./MarkdownEditorImpl");
  }
  return markdownEditorModulePromise;
}

function MarkdownEditorFallback({
  value,
  onChange,
  placeholder,
  className,
  contentClassName,
  onBlur,
  onSubmit,
  onLoadIntent,
  textareaRef,
  bordered = true,
}: Pick<
  MarkdownEditorProps,
  "value" | "onChange" | "placeholder" | "className" | "contentClassName" | "onBlur" | "onSubmit" | "bordered"
> & {
  onLoadIntent: (reason: "hover" | "focus" | "input") => void;
  textareaRef?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <div
      className={cn(
        "relative paperclip-mdxeditor-scope",
        bordered ? "rounded-md border border-border bg-transparent" : "bg-transparent",
        className,
      )}
    >
      <div className={cn("paperclip-mdxeditor", !bordered && "paperclip-mdxeditor--borderless")}>
        <textarea
          ref={textareaRef}
          rows={bordered ? 4 : 2}
          value={value}
          placeholder={placeholder || "Loading editor..."}
          onPointerEnter={() => onLoadIntent("hover")}
          onFocus={() => onLoadIntent("focus")}
          onChange={(event) => {
            onLoadIntent("input");
            onChange(event.target.value);
          }}
          onBlur={() => onBlur?.()}
          onKeyDown={(event) => {
            if (onSubmit && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onSubmit();
            }
          }}
          className={cn(
            "paperclip-mdxeditor-content block w-full resize-y border-0 bg-transparent p-0 text-sm text-foreground outline-none placeholder:text-muted-foreground",
            bordered ? "min-h-24 px-3 py-2" : "min-h-16 px-0 py-0",
            contentClassName,
          )}
        />
      </div>
    </div>
  );
}

export const MarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(function MarkdownEditor(
  props,
  forwardedRef,
) {
  const [EditorComponent, setEditorComponent] = useState<MarkdownEditorComponent | null>(null);
  const [loadRequested, setLoadRequested] = useState(() => props.value.trim().length > 0);
  const [fallbackFocused, setFallbackFocused] = useState(false);
  const innerRef = useRef<MarkdownEditorRef>(null);
  const fallbackRef = useRef<HTMLTextAreaElement | null>(null);

  const requestLoad = useCallback(() => {
    setLoadRequested(true);
    void loadMarkdownEditor();
  }, []);

  useImperativeHandle(forwardedRef, () => ({
    focus: () => {
      if (innerRef.current) {
        innerRef.current.focus();
        return;
      }
      requestLoad();
      fallbackRef.current?.focus();
    },
  }), [requestLoad]);

  useEffect(() => {
    if (!loadRequested) return;
    let active = true;
    void loadMarkdownEditor().then((module) => {
      if (!active) return;
      setEditorComponent(() => module.default);
    });
    return () => {
      active = false;
    };
  }, [loadRequested]);

  useEffect(() => {
    if (!loadRequested && props.value.trim().length > 0) {
      requestLoad();
    }
  }, [loadRequested, props.value, requestLoad]);

  if (!EditorComponent || fallbackFocused) {
    return (
      <MarkdownEditorFallback
        {...props}
        textareaRef={fallbackRef}
        onLoadIntent={(reason) => {
          if (reason === "focus" || reason === "input") {
            setFallbackFocused(true);
          }
          requestLoad();
        }}
        onBlur={() => {
          setFallbackFocused(false);
          props.onBlur?.();
        }}
      />
    );
  }

  return <EditorComponent {...props} ref={innerRef} />;
});
