import type { CSSProperties } from "react";
import { ArtifactFront } from "./ArtifactFront";
import { fitPrint, useImageAspect, usePreviewFailure } from "./ArtifactPrint";
import backingShort from "./assets/backing-short.svg";
import backingTallA from "./assets/backing-tall-a.svg";
import backingTallB from "./assets/backing-tall-b.svg";
import { LANDSCAPE_SHEET, MEDIA_ANCHOR, MEDIA_BACKING, MEDIA_COMPOSITION, SHEET, SHEET_BACKING, SHEET_COMPOSITION, SHEET_FRONT, STACK_BOX, type BackingPlacement } from "./geometry";
import { isMedia, isPortrait, previewSourceOf, treatmentOf, type ArtifactSubject } from "./kinds";

/**
 * A stack: the task's newest artifact as the first page, in front of one of
 * the mock's two backings. Text and documents share the sheet backing;
 * pictures, video and audio share the media backing. Both compositions are
 * 240–241px tall and stand on the frame's bottom edge, so the tops of every
 * stack in a row line up; a leading picture is fitted inside that height. A
 * leading picture that cannot be loaded stands as a sheet, where audio does.
 *
 * The backings are the mock's own sheet shapes (each file is 30px larger than
 * its sheet on every side, room the mock's shadow needed; the shadow itself
 * is the `.artifact-backing` rule). Each sheet is placed by the centre of its
 * rotated box and turned about its own centre; the hover fan is in index.css.
 */
const FILES = { short: backingShort, tallA: backingTallA, tallB: backingTallB } as const;

function Backing({ file, width, height, sheet, centre, rotate, spread }: BackingPlacement) {
  const originX = sheet.left + sheet.width / 2;
  const originY = sheet.top + sheet.height / 2;
  const style = {
    left: centre.x - originX,
    top: centre.y - originY,
    width,
    height,
    transformOrigin: `${originX}px ${originY}px`,
    "--artifact-base": `${rotate}deg`,
  } as CSSProperties;
  return (
    <img
      data-artifact-rotate
      data-artifact-spread={spread}
      src={FILES[file]}
      alt=""
      width={width}
      height={height}
      draggable={false}
      className="artifact-backing pointer-events-none absolute max-w-none"
      style={style}
    />
  );
}

export function ArtifactStack({ front }: { front: ArtifactSubject }) {
  const [aspect, onMediaLoad] = useImageAspect(front.aspect);
  const [failed, onMediaError] = usePreviewFailure(previewSourceOf(front));
  if (isMedia(front)) {
    const print = !failed && treatmentOf(front) === "media" ? fitPrint(aspect, STACK_BOX) : null;
    const size = print ?? { width: SHEET.width, height: SHEET.height };
    const anchor = print && !isPortrait(aspect) ? MEDIA_ANCHOR.landscape : MEDIA_ANCHOR.portrait;
    const left = anchor.x - size.width / 2;
    const top = Math.min(Math.max(anchor.y - size.height / 2, 0), MEDIA_COMPOSITION.height - size.height);
    return (
      <div data-artifact-stack="media" className="relative shrink-0" style={{ width: Math.max(MEDIA_COMPOSITION.width, left + size.width), height: MEDIA_COMPOSITION.height }}>
        {MEDIA_BACKING.map((sheet) => (
          <Backing key={sheet.file} {...sheet} />
        ))}
        <ArtifactFront subject={front} print={print ?? undefined} onMediaLoad={onMediaLoad} onMediaError={onMediaError} style={{ position: "absolute", left, top }} />
      </div>
    );
  }
  return (
    <div data-artifact-stack="sheet" className="relative shrink-0" style={{ width: SHEET_COMPOSITION.width, height: SHEET_COMPOSITION.height }}>
      {SHEET_BACKING.map((sheet) => (
        <Backing key={sheet.file} {...sheet} />
      ))}
      <div
        data-artifact-rotate
        data-artifact-spread={LANDSCAPE_SHEET.spread}
        aria-hidden
        className="absolute"
        style={{
          left: LANDSCAPE_SHEET.centre.x - LANDSCAPE_SHEET.width / 2,
          top: LANDSCAPE_SHEET.centre.y - LANDSCAPE_SHEET.height / 2,
          width: LANDSCAPE_SHEET.width,
          height: LANDSCAPE_SHEET.height,
          borderRadius: "var(--artifact-sheet-radius)",
          background: "var(--artifact-paper)",
          boxShadow: "var(--artifact-sheet-inset-stroke), var(--artifact-shadow-print)",
          "--artifact-base": `${LANDSCAPE_SHEET.rotate}deg`,
        } as CSSProperties}
      />
      <ArtifactFront subject={front} style={{ position: "absolute", left: SHEET_FRONT.left, top: SHEET_FRONT.top }} />
    </div>
  );
}
