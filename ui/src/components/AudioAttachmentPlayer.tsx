import { useEffect, useId, useRef } from "react";
import { Trash2 } from "lucide-react";
import type { IssueAttachment } from "@paperclipai/shared";
import { claimAudioPlayback, releaseAudioPlayback } from "@/lib/audio-playback-coordinator";
import { cn } from "@/lib/utils";

interface AudioAttachmentPlayerProps {
  attachment: IssueAttachment;
  onDelete?: () => void;
  deletePending?: boolean;
  className?: string;
}

export function AudioAttachmentPlayer({
  attachment,
  onDelete,
  deletePending = false,
  className,
}: AudioAttachmentPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const labelId = useId();
  const filename = attachment.originalFilename ?? attachment.id;
  const sizeKb = (attachment.byteSize / 1024).toFixed(1);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handlePlay = () => claimAudioPlayback(audio);
    const handlePause = () => releaseAudioPlayback(audio);
    const handleEnded = () => releaseAudioPlayback(audio);

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      releaseAudioPlayback(audio);
    };
  }, []);

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-accent/5 p-2 space-y-1.5",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0">
          <p id={labelId} className="text-xs font-medium truncate" title={filename}>
            {filename}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {attachment.contentType} · {sizeKb} KB
          </p>
        </div>
        {onDelete ? (
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            disabled={deletePending}
            title="Delete attachment"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={attachment.contentPath}
        aria-labelledby={labelId}
        className="h-9 w-full"
      />
    </div>
  );
}
