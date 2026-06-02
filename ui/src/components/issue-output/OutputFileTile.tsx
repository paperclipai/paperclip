import { cn } from "@/lib/utils";
import { getOutputFileGlyph, type OutputFileTone } from "@/lib/issue-output";

const TONE_CLASSES: Record<OutputFileTone, string> = {
  video: "bg-indigo-500/15 text-indigo-300",
  pdf: "bg-red-500/15 text-red-300",
  zip: "bg-amber-500/15 text-amber-300",
  image: "bg-emerald-500/15 text-emerald-300",
  bin: "bg-muted text-muted-foreground",
};

interface OutputFileTileProps {
  contentType: string | null | undefined;
  className?: string;
  /** Tailwind size classes for the square tile. Defaults to a 32×32 tile. */
  sizeClassName?: string;
}

/** Square file-type tile showing a short MIME-derived label, colorised by tone. */
export function OutputFileTile({ contentType, className, sizeClassName = "h-8 w-8" }: OutputFileTileProps) {
  const glyph = getOutputFileGlyph(contentType);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md text-[10px] font-semibold tabular-nums",
        sizeClassName,
        TONE_CLASSES[glyph.tone],
        className,
      )}
      aria-hidden="true"
    >
      {glyph.label}
    </span>
  );
}
