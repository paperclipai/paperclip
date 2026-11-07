import { t, useTranslation, Trans } from "@/i18n";
import { useEffect, useState } from "react";
import { ImageIcon, Loader2, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ComposerImageAttachment {
  id: string;
  name: string;
  file?: File;
  contentPath?: string;
  status?: "uploading" | "attached" | "error";
  error?: string;
}

function ImageAttachment({ image, disabled, onRemove, onRetry }: {
  image: ComposerImageAttachment;
  disabled?: boolean;
  onRemove: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  useTranslation("task-components");
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    if (!image.file || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(image.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image.file]);
  const src = preview ?? image.contentPath;

  return (
    <div className="w-20 shrink-0" title={image.error ?? image.name}>
      <div className={cn(
        "relative size-20 overflow-hidden rounded-lg border bg-muted",
        image.status === "error" && "border-destructive",
      )}>
        {src ? (
          <img src={src} alt={image.name} className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <ImageIcon className="size-5" aria-hidden />
          </div>
        )}
        {image.status === "uploading" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60" role="status">
            <Loader2 className="size-5 animate-spin" aria-hidden />
            <span className="sr-only"><Trans ns="task-components" i18nKey="sentence_bad262309b5c" components={{ part1: <>{image.name}</> }} /></span>
          </div>
        ) : null}
        <Button
          type="button" variant="secondary" size="icon-xs"
          className="absolute right-1 top-1 rounded-full"
          aria-label={t("task-components:remove_d2f6b9b7", { value1: image.name })}
          disabled={disabled} onClick={() => onRemove(image.id)}
        >
          <X aria-hidden />
        </Button>
        {image.status === "error" && onRetry ? (
          <Button
            type="button" variant="secondary" size="icon-xs"
            className="absolute bottom-1 left-1 rounded-full"
            aria-label={t("task-chat-ui:retryFile", { name: image.name })}
            disabled={disabled} onClick={() => onRetry(image.id)}
          >
            <RotateCw aria-hidden />
          </Button>
        ) : null}
      </div>
      {image.status === "error" ? (
        <p className="mt-1 text-xs text-destructive" role="alert">{image.error ?? t("task-components:uploadFailed_6efc5d27")}</p>
      ) : null}
    </div>
  );
}

export function ComposerImageAttachments({ images, disabled, onRemove, onRetry }: {
  images: ComposerImageAttachment[];
  disabled?: boolean;
  onRemove: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  useTranslation("task-components");
  if (!images.length) return null;
  return (
    <div
      className="mb-2 flex flex-wrap gap-2 px-1"
      role="group" aria-label={t("task-chat-ui:imageAttachments")}
      data-testid="task-chat-composer-images"
    >
      {images.map(image => (
        <ImageAttachment key={image.id} image={image} disabled={disabled} onRemove={onRemove} onRetry={onRetry} />
      ))}
    </div>
  );
}
