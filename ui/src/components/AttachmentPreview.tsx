import { useEffect, useState } from "react";
import type { IssueAttachment } from "@paperclipai/shared";
import { Trash2, Copy, Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../lib/utils";

interface AttachmentPreviewProps {
  attachment: IssueAttachment;
  onDelete: (id: string) => void;
  deleteDisabled?: boolean;
}

function FileSizeLabel({ byteSize }: { byteSize: number }) {
  return <span>{(byteSize / 1024).toFixed(1)} KB</span>;
}

function DeleteButton({
  onDelete,
  id,
  disabled,
}: {
  onDelete: (id: string) => void;
  id: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-destructive flex-shrink-0"
      onClick={() => onDelete(id)}
      disabled={disabled}
      title="Delete attachment"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}

function VideoPreview({ attachment, onDelete, deleteDisabled }: AttachmentPreviewProps) {
  return (
    <div className={cn("border border-border rounded-md p-2")}>
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-xs truncate"
          title={attachment.originalFilename ?? attachment.id}
        >
          {attachment.originalFilename ?? attachment.id}
        </span>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[11px] text-muted-foreground">
            <FileSizeLabel byteSize={attachment.byteSize} />
          </span>
          <DeleteButton onDelete={onDelete} id={attachment.id} disabled={deleteDisabled} />
        </div>
      </div>
      <video
        controls
        className="w-full rounded-md mt-1.5 max-h-64"
        src={attachment.contentPath}
      />
    </div>
  );
}

function TextPreview({ attachment, onDelete, deleteDisabled }: AttachmentPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!expanded || content !== null) return;
    setLoading(true);
    setError(false);
    fetch(attachment.contentPath)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch");
        return res.text();
      })
      .then((text) => {
        setContent(text);
      })
      .catch(() => {
        setError(true);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [expanded, attachment.contentPath, content]);

  const handleCopy = () => {
    if (!content) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className={cn("border border-border rounded-md p-2")}>
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-xs truncate"
          title={attachment.originalFilename ?? attachment.id}
        >
          {attachment.originalFilename ?? attachment.id}
        </span>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[11px] text-muted-foreground">
            <FileSizeLabel byteSize={attachment.byteSize} />
          </span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
          <DeleteButton onDelete={onDelete} id={attachment.id} disabled={deleteDisabled} />
        </div>
      </div>

      {expanded && (
        <div className="mt-1.5">
          {loading && (
            <p className="text-[11px] text-muted-foreground">Loading...</p>
          )}
          {error && (
            <p className="text-[11px] text-muted-foreground">Failed to load</p>
          )}
          {!loading && !error && content !== null && (
            <div className="relative">
              <pre className="text-[11px] font-mono bg-muted rounded p-2 mt-0 overflow-auto max-h-48 whitespace-pre-wrap break-all">
                {content}
              </pre>
              <button
                type="button"
                className="absolute top-1.5 right-1.5 text-muted-foreground hover:text-foreground"
                onClick={handleCopy}
                title="Copy to clipboard"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GenericPreview({ attachment, onDelete, deleteDisabled }: AttachmentPreviewProps) {
  return (
    <div className={cn("border border-border rounded-md p-2")}>
      <div className="flex items-center justify-between gap-2">
        <a
          href={attachment.contentPath}
          target="_blank"
          rel="noreferrer"
          className="text-xs hover:underline truncate"
          title={attachment.originalFilename ?? attachment.id}
        >
          {attachment.originalFilename ?? attachment.id}
        </a>
        <DeleteButton onDelete={onDelete} id={attachment.id} disabled={deleteDisabled} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {attachment.contentType} · <FileSizeLabel byteSize={attachment.byteSize} />
      </p>
    </div>
  );
}

export function AttachmentPreview({ attachment, onDelete, deleteDisabled }: AttachmentPreviewProps) {
  if (attachment.contentType.startsWith("video/")) {
    return (
      <VideoPreview
        attachment={attachment}
        onDelete={onDelete}
        deleteDisabled={deleteDisabled}
      />
    );
  }

  if (
    attachment.contentType.startsWith("text/") ||
    attachment.contentType === "application/json"
  ) {
    return (
      <TextPreview
        attachment={attachment}
        onDelete={onDelete}
        deleteDisabled={deleteDisabled}
      />
    );
  }

  return (
    <GenericPreview
      attachment={attachment}
      onDelete={onDelete}
      deleteDisabled={deleteDisabled}
    />
  );
}
