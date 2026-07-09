import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { AlertTriangle, Check, Loader2, Paperclip, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarkdownEditor,
  type MarkdownEditorRef,
  type MentionOption,
} from "../../components/MarkdownEditor";
import { cn } from "../../lib/utils";

export type BoardChatPendingAttachment = {
  id: string;
  name: string;
  size: number;
  status: "uploading" | "attached" | "error";
  inline: boolean;
  error?: string;
};

function formatAttachmentSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageFile(file: File) {
  return file.type.startsWith("image/");
}

export interface BoardChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  mentions: MentionOption[];
  disabled?: boolean;
  submitting?: boolean;
  editorRef?: React.RefObject<MarkdownEditorRef | null>;
  /** Returns contentPath for inline image markdown. */
  onUploadImage?: (file: File) => Promise<string>;
  /** Attach non-image (or any) file; returns contentPath for markdown link. */
  onAttachFile?: (file: File) => Promise<string>;
  canAttach?: boolean;
}

export function BoardChatComposer({
  value,
  onChange,
  onSubmit,
  mentions,
  disabled = false,
  submitting = false,
  editorRef,
  onUploadImage,
  onAttachFile,
  canAttach = false,
}: BoardChatComposerProps) {
  const attachInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<BoardChatPendingAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);

  const upsertAttachment = useCallback((next: BoardChatPendingAttachment) => {
    setAttachments((prev) => {
      const idx = prev.findIndex((item) => item.id === next.id);
      if (idx < 0) return [...prev, next];
      const copy = prev.slice();
      copy[idx] = next;
      return copy;
    });
  }, []);

  const canSend = !disabled && value.trim().length > 0;

  const handleFile = useCallback(
    async (file: File) => {
      if (!canAttach || (!onUploadImage && !onAttachFile)) return;
      const id = `pending-${file.name}-${file.size}-${Date.now()}`;
      const inline = Boolean(onUploadImage && isImageFile(file));
      upsertAttachment({
        id,
        name: file.name,
        size: file.size,
        status: "uploading",
        inline,
      });
      setAttaching(true);
      try {
        if (inline && onUploadImage) {
          const contentPath = await onUploadImage(file);
          const markdown = `![${file.name}](${contentPath})`;
          onChange(value ? `${value}\n\n${markdown}` : markdown);
          upsertAttachment({
            id,
            name: file.name,
            size: file.size,
            status: "attached",
            inline: true,
          });
        } else if (onAttachFile) {
          const contentPath = await onAttachFile(file);
          const markdown = `[${file.name}](${contentPath})`;
          onChange(value ? `${value}\n\n${markdown}` : markdown);
          upsertAttachment({
            id,
            name: file.name,
            size: file.size,
            status: "attached",
            inline: false,
          });
        }
      } catch (err) {
        upsertAttachment({
          id,
          name: file.name,
          size: file.size,
          status: "error",
          inline,
          error: err instanceof Error ? err.message : "Upload failed",
        });
      } finally {
        setAttaching(false);
      }
    },
    [canAttach, onAttachFile, onChange, onUploadImage, upsertAttachment, value],
  );

  const handleAttachChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const handleDragEnter = useCallback(
    (event: DragEvent) => {
      if (!canAttach) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDragOver(true);
    },
    [canAttach],
  );

  const handleDragOver = useCallback(
    (event: DragEvent) => {
      if (!canAttach) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [canAttach],
  );

  const handleDragLeave = useCallback((event: DragEvent) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent) => {
      if (!canAttach) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragOver(false);
      const files = Array.from(event.dataTransfer.files ?? []);
      for (const file of files) void handleFile(file);
    },
    [canAttach, handleFile],
  );

  return (
    <div
      data-testid="board-chat-composer"
      aria-busy={disabled || submitting || attaching ? "true" : undefined}
      className={cn(
        "pointer-events-auto relative rounded-md border border-border/70 bg-background/95 p-[15px] shadow-[0_-12px_28px_rgba(15,23,42,0.08)] backdrop-blur transition-[border-color,background-color,box-shadow] duration-150 supports-[backdrop-filter]:bg-background/85 dark:shadow-[0_-12px_28px_rgba(0,0,0,0.28)]",
        isDragOver &&
          "border-primary/45 bg-background shadow-[0_-12px_28px_rgba(15,23,42,0.08),0_0_0_1px_hsl(var(--primary)/0.16)]",
      )}
      onDragEnterCapture={handleDragEnter}
      onDragOverCapture={handleDragOver}
      onDragLeaveCapture={handleDragLeave}
      onDropCapture={handleDrop}
    >
      {isDragOver && canAttach ? (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-sm border border-dashed border-primary/55 bg-background/75 px-4 py-3 text-center shadow-sm backdrop-blur-[2px]">
          <div className="flex max-w-md items-center gap-3 rounded-md bg-background/80 px-3 py-2 text-left shadow-sm ring-1 ring-border/60">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Paperclip className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">Solte para anexar</div>
              <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Images insert into the message. Other files attach to the room issue.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div aria-label="Mensagem à Conference Room">
        <MarkdownEditor
          ref={editorRef}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          submitKey="enter"
          placeholder="Mensagem à sala… use @ para chamar um agente"
          mentions={mentions}
          readOnly={disabled}
          imageUploadHandler={canAttach ? onUploadImage : undefined}
          fileDropTarget="parent"
          bordered={false}
          contentClassName="max-h-[28dvh] overflow-y-auto pr-1 pb-2 text-sm scrollbar-auto-hide"
        />
      </div>

      {attachments.length > 0 ? (
        <div
          data-testid="board-chat-composer-attachments"
          className="mb-3 mt-2 space-y-1.5 rounded-md border border-dashed border-border/80 bg-muted/20 p-2"
        >
          {attachments.map((attachment) => {
            const sizeLabel = formatAttachmentSize(attachment.size);
            const statusLabel =
              attachment.status === "uploading"
                ? "Uploading…"
                : attachment.status === "error"
                  ? attachment.error ?? "Upload failed"
                  : attachment.inline
                    ? "Inserted inline"
                    : "Attached to room";
            return (
              <div
                key={attachment.id}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-xs",
                  attachment.status === "error"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-background/70 text-muted-foreground",
                )}
              >
                {attachment.status === "uploading" ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : attachment.status === "attached" ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {attachment.name}
                </span>
                {sizeLabel ? (
                  <span className="shrink-0 text-muted-foreground">{sizeLabel}</span>
                ) : null}
                <span className="shrink-0 text-muted-foreground">{statusLabel}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {canAttach ? (
            <>
              <input
                ref={attachInputRef}
                type="file"
                className="hidden"
                data-testid="board-chat-attach-input"
                onChange={handleAttachChange}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => attachInputRef.current?.click()}
                disabled={disabled || attaching}
                title="Anexar arquivo"
                aria-label="Anexar arquivo"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              Anexos disponíveis após a sala criar a issue Board Operations.
            </span>
          )}
          <span className="flex-1" />
          <Button
            type="button"
            size="icon-sm"
            onClick={() => {
              if (canSend) onSubmit();
            }}
            disabled={!canSend || submitting}
            aria-label="Enviar mensagem"
            title="Enviar mensagem"
            data-testid="board-chat-send"
            className={cn(
              canSend && !submitting
                ? "bg-foreground text-background hover:opacity-90"
                : "bg-accent text-muted-foreground",
            )}
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <span className="text-[11px] text-muted-foreground">
          Enter envia · Shift+Enter nova linha · @ menciona agente
        </span>
      </div>
    </div>
  );
}
