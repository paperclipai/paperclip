import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { attachmentDownloadPath, attachmentFilename } from "@/lib/issue-attachments";
import { isVideoLikeOutput } from "@/lib/issue-output";

export interface GalleryMediaItem {
  id: string;
  contentPath: string;
  openPath?: string;
  downloadPath?: string;
  contentType: string;
  originalFilename: string | null;
}

interface ImageGalleryModalProps {
  items: GalleryMediaItem[];
  initialIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImageGalleryModal({
  items,
  initialIndex,
  open,
  onOpenChange,
}: ImageGalleryModalProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const mediaRef = useRef<HTMLImageElement | HTMLVideoElement | null>(null);
  const setMediaRef = useCallback((node: HTMLImageElement | HTMLVideoElement | null) => {
    mediaRef.current = node;
  }, []);

  useEffect(() => {
    if (open) setCurrentIndex(initialIndex);
  }, [open, initialIndex]);

  const goNext = useCallback(() => {
    setCurrentIndex((i) => (i + 1) % items.length);
  }, [items.length]);

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => (i - 1 + items.length) % items.length);
  }, [items.length]);

  useEffect(() => {
    if (currentIndex < items.length) return;
    setCurrentIndex(0);
  }, [currentIndex, items.length]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") goNext();
      else if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, goNext, goPrev, onOpenChange]);

  /** Close when clicking empty curtain space (not interactive elements or the image) */
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.closest("button") ||
        target.closest("a") ||
        target === mediaRef.current
      )
        return;
      onOpenChange(false);
    },
    [onOpenChange],
  );

  if (items.length === 0) return null;

  const current = items[currentIndex];
  if (!current) return null;
  const filename = attachmentFilename(current);
  const isVideo = isVideoLikeOutput(current.contentType, current.originalFilename);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* Full-screen curtain */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/90 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200"
          onClick={handleBackdropClick}
        >
          {/* Top bar */}
          <div className="flex items-center justify-between px-5 py-3 text-white/80 text-sm shrink-0">
            <span className="truncate max-w-[50%] font-medium" title={filename}>
              {filename}
            </span>
            <div className="flex items-center gap-4">
              <span className="text-white/40 tabular-nums text-xs">
                {currentIndex + 1} / {items.length}
              </span>
              <a
                href={attachmentDownloadPath(current)}
                download={filename}
                className="text-white/50 hover:text-white transition-colors"
                title="Download"
                aria-label={`Download ${filename}`}
                onClick={(e) => e.stopPropagation()}
              >
                <Download className="h-4.5 w-4.5" />
              </a>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="text-white/50 hover:text-white transition-colors"
                title="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Main area: nav buttons outside image */}
          <div className="flex-1 flex items-center min-h-0">
            {/* Left nav zone */}
            <div className="w-16 md:w-24 shrink-0 flex items-center justify-center h-full">
              {items.length > 1 && (
                <button
                  type="button"
                  onClick={goPrev}
                  className="rounded-full bg-white/10 p-3 text-white/60 hover:text-white hover:bg-white/20 transition-colors"
                  title="Previous"
                >
                  <ChevronLeft className="h-7 w-7" />
                </button>
              )}
            </div>

            {/* Media */}
            <div className="flex-1 flex items-center justify-center min-w-0 min-h-0 h-full px-2">
              {isVideo ? (
                <video
                  ref={setMediaRef}
                  src={current.contentPath}
                  className="max-w-full max-h-full rounded-lg"
                  controls
                  playsInline
                />
              ) : (
                <img
                  ref={setMediaRef}
                  src={current.contentPath}
                  alt={filename}
                  className="max-w-full max-h-full object-contain select-none rounded-lg"
                  draggable={false}
                />
              )}
            </div>

            {/* Right nav zone */}
            <div className="w-16 md:w-24 shrink-0 flex items-center justify-center h-full">
              {items.length > 1 && (
                <button
                  type="button"
                  onClick={goNext}
                  className="rounded-full bg-white/10 p-3 text-white/60 hover:text-white hover:bg-white/20 transition-colors"
                  title="Next"
                >
                  <ChevronRight className="h-7 w-7" />
                </button>
              )}
            </div>
          </div>

          {/* Bottom padding for balance */}
          <div className="h-6 shrink-0" />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
