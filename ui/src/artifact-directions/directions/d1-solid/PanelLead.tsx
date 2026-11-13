import { useRef, useState } from "react";
import type { LabArtifact } from "../../kit";
import { KindTag, PlatePicture } from "./KindBlock";

/**
 * PANEL — what leads a card whose artifact is a picture: the picture itself,
 * at 16:9 across the card, with the ink kind tab in its bottom-left corner —
 * the same rule as the thread and the gallery (the picture is the plate and
 * carries the tab), so nothing is represented twice.
 *
 * A video plays in place: its poster is the play button, and the product's
 * controls take over once it has started. A picture that fails to load reports
 * it, and the card falls back to the ink kind block.
 */

const LEAD = "relative aspect-(--solid-lead-ratio) w-full overflow-hidden rounded-md bg-(--solid-sheet)";

function VideoLead({ artifact }: { artifact: LabArtifact }) {
  const video = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  return (
    <div data-solid="panel-lead" data-lead="video" className={LEAD}>
      <video
        ref={video}
        src={artifact.videoUrl}
        poster={artifact.thumbnailUrl}
        preload="metadata"
        playsInline
        controls={started}
        aria-label={artifact.title}
        className="absolute inset-0 size-full object-cover"
      />
      {started ? null : (
        <button
          type="button"
          aria-label={`Play video: ${artifact.title}`}
          title="Play video"
          onClick={() => {
            setStarted(true);
            void video.current?.play();
          }}
          className="absolute inset-0 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--solid-ink)"
        >
          <KindTag artifact={artifact} />
        </button>
      )}
    </div>
  );
}

export function PanelLead({ artifact, onPictureError }: { artifact: LabArtifact; onPictureError: () => void }) {
  if (artifact.kind === "video" && artifact.videoUrl) return <VideoLead artifact={artifact} />;
  return (
    <div aria-hidden data-solid="panel-lead" data-lead="picture" className={LEAD}>
      <PlatePicture artifact={artifact} onError={onPictureError} />
      <KindTag artifact={artifact} />
    </div>
  );
}
