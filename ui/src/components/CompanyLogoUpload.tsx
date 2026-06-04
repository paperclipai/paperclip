import { useId, useRef, useState, type DragEvent } from "react";
import { ImageUp, Loader2, X } from "lucide-react";
import { cn } from "../lib/utils";
import { CompanyPatternIcon } from "./CompanyPatternIcon";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
const ACCEPTED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — logos are small

/**
 * Company logo / image upload. A clickable, drag-and-drop avatar tile that
 * previews the current logo (or the generated CompanyPatternIcon fallback),
 * with a hover overlay to change it, a remove affordance, upload + error
 * states, and client-side type/size validation. GLASSHOUSE-styled.
 *
 * Backend-agnostic: the parent owns the mutation and passes `onFile` / `onRemove`
 * plus `uploading` / `error`. Used in Company Settings and the onboarding wizard.
 */
export interface CompanyLogoUploadProps {
  companyName: string;
  logoUrl: string | null;
  brandColor?: string | null;
  onFile: (file: File) => void;
  onRemove?: () => void;
  uploading?: boolean;
  /** Upload error from the parent mutation. */
  error?: string | null;
  /** Max accepted file size in bytes. Default 5 MB. */
  maxBytes?: number;
  /** Tile size in px. Default 80. */
  size?: number;
  disabled?: boolean;
  className?: string;
}

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
}

export function CompanyLogoUpload({
  companyName,
  logoUrl,
  brandColor,
  onFile,
  onRemove,
  uploading = false,
  error,
  maxBytes = DEFAULT_MAX_BYTES,
  size = 80,
  disabled = false,
  className,
}: CompanyLogoUploadProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const hasLogo = typeof logoUrl === "string" && logoUrl.trim().length > 0;
  const shownError = localError ?? error ?? null;

  function validateAndEmit(file: File | null | undefined) {
    if (!file) return;
    if (!ACCEPTED_TYPES.has(file.type)) {
      setLocalError("Use a PNG, JPEG, WEBP, GIF, or SVG image.");
      return;
    }
    if (file.size > maxBytes) {
      setLocalError(`Image must be under ${formatMb(maxBytes)}.`);
      return;
    }
    setLocalError(null);
    onFile(file);
  }

  function openPicker() {
    if (disabled || uploading) return;
    inputRef.current?.click();
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (disabled || uploading) return;
    validateAndEmit(e.dataTransfer.files?.[0]);
  }

  return (
    <div className={cn("flex items-start gap-4", className)}>
      <div className="shrink-0">
        <button
          type="button"
          onClick={openPicker}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled && !uploading) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          disabled={disabled}
          aria-label={hasLogo ? "Change company logo" : "Upload company logo"}
          className={cn(
            "group relative block overflow-hidden rounded-[14px] border outline-none transition-colors",
            "focus-visible:ring-2 focus-visible:ring-ring",
            dragging
              ? "border-primary ring-2 ring-primary"
              : "border-border hover:border-primary/50",
            disabled && "cursor-not-allowed opacity-60",
          )}
          style={{ width: size, height: size }}
        >
          <CompanyPatternIcon
            companyName={companyName || "?"}
            logoUrl={hasLogo ? logoUrl : null}
            brandColor={brandColor}
            className="h-full w-full rounded-[13px]"
          />

          {/* hover / drag overlay */}
          <span
            className={cn(
              "absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/72 text-center transition-opacity",
              dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              uploading && "opacity-0",
            )}
          >
            <ImageUp className="h-5 w-5 text-foreground" />
            <span className="px-1 text-[10px] font-medium leading-tight text-foreground">
              {dragging ? "Drop image" : hasLogo ? "Change" : "Upload"}
            </span>
          </span>

          {/* uploading overlay */}
          {uploading && (
            <span className="absolute inset-0 flex items-center justify-center bg-background/72">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </span>
          )}
        </button>
      </div>

      <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
        <div className="text-sm font-medium text-foreground">Logo</div>
        <p className="text-xs text-muted-foreground">
          Click or drop an image. PNG, JPEG, WEBP, GIF, or SVG, up to {formatMb(maxBytes)}.
        </p>
        <div className="flex items-center gap-3 pt-0.5">
          <button
            type="button"
            onClick={openPicker}
            disabled={disabled || uploading}
            className="rounded-[2px] border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-primary/50 disabled:opacity-50"
          >
            {uploading ? "Uploading…" : hasLogo ? "Replace" : "Choose image"}
          </button>
          {hasLogo && onRemove && (
            <button
              type="button"
              onClick={() => {
                setLocalError(null);
                onRemove();
              }}
              disabled={disabled || uploading}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
            >
              <X className="h-3 w-3" />
              Remove
            </button>
          )}
        </div>
        {shownError && (
          <p className="text-xs text-destructive">{shownError}</p>
        )}
      </div>

      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          e.currentTarget.value = "";
          validateAndEmit(file);
        }}
      />
    </div>
  );
}
