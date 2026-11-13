import type { CSSProperties } from "react";
import type { LabArtifact } from "../../kit";
import backingShort from "./backing-short.svg";
import backingTallA from "./backing-tall-a.svg";
import backingTallB from "./backing-tall-b.svg";
import { Front } from "./Front";
import { isMedia, isPortrait, treatmentOf } from "./kinds";
import { fitPrint, STACK_BOX } from "./MediaPrint";

/**
 * A stack: the task's newest artifact as the first page, in front of one of
 * the mock's two backings. Text and documents share the sheet backing; images,
 * video and audio share the media backing. Both compositions are 240–241px
 * tall and stand on the frame's bottom edge, so the tops of every stack in a
 * row line up; a leading picture is fitted inside that height, never past it.
 *
 * The backings are the mock's own SVGs (each a rounded sheet; the file is 30px
 * larger than the sheet on every side, room the mock's baked-in shadow needed —
 * the shadow itself is now the same CSS drop-shadow the front sheet wears, so
 * the light theme's lighter value reaches the backings too).
 * Positions come from the mock's layout: each sheet's rotated bounding box is
 * placed in a fixed composition, so here every sheet is placed by the centre
 * of that box and turned about its own centre.
 */

interface Placed {
  src: string;
  /** The SVG file's size. */
  width: number;
  height: number;
  /** Where the sheet sits inside the file. */
  sheet: { left: number; top: number; width: number; height: number };
  /** Centre of the rotated bounding box within the composition. */
  centre: { x: number; y: number };
  rotate: number;
  /** Which side the page is on, for the lab's animation toggle: on hover left pages turn +5°, right pages −5°. */
  spread: "left" | "right";
}

function BackingSheet({ src, width, height, sheet, centre, rotate, spread }: Placed) {
  const originX = sheet.left + sheet.width / 2;
  const originY = sheet.top + sheet.height / 2;
  const style = {
    left: centre.x - originX,
    top: centre.y - originY,
    width,
    height,
    transformOrigin: `${originX}px ${originY}px`,
    filter: "var(--v1-shadow-sheet)",
    "--v1-base": `${rotate}deg`,
  } as CSSProperties;
  return <img data-rotate data-spread={spread} src={src} alt="" width={width} height={height} draggable={false} className="pointer-events-none absolute max-w-none" style={style} />;
}

// Sheet backing (text and documents): composition 254.25 × 241.04, bottom-aligned in the frame.
// Its short sheet sits left of centre and already leans left (−14°), so it is the pair's
// left page; the wide landscape sheet (−5°) is the right page.
const SHORT_SHEET = { left: 30, top: 26.6, width: 180.409, height: 187.814 };
const SHEET_BACKING: Placed[] = [
  { src: backingShort, width: 240.409, height: 247.814, sheet: SHORT_SHEET, centre: { x: 7.13 + 220.486 / 2, y: 225.88 / 2 }, rotate: -14, spread: "left" },
];
// Its second layer is a plain landscape sheet, 239.5 × 179.6 with a 12px radius, turned −5°.
const LANDSCAPE_SHEET = { width: 239.509, height: 179.632, centre: { x: 254.253 / 2, y: 33.5 + 199.823 / 2 }, rotate: -5, spread: "right" as const };

// Media backing (pictures, video, audio): the two tall sheets span 250.78 × 240.34; the
// composition grows to the right when a landscape print reaches past them (mock: 261.77).
// Painted back to front: the right sheet first (2px lower than the mock's layout box),
// then the left sheet in front of it, then the print.
const TALL_SHEET = { left: 30, top: 26.6, width: 180.409, height: 216.151 };
const MEDIA_BACKING: Placed[] = [
  { src: backingTallA, width: 240.409, height: 276.151, sheet: TALL_SHEET, centre: { x: 55.73 + 195.048 / 2, y: 12.13 + 228.209 / 2 + 2 }, rotate: 4, spread: "right" },
  { src: backingTallB, width: 240.409, height: 276.151, sheet: TALL_SHEET, centre: { x: 207.544 / 2, y: 238.217 / 2 }, rotate: -7.64, spread: "left" },
];
const MEDIA_BACKING_WIDTH = 55.73 + 195.048;
const MEDIA_HEIGHT = 240.337;
// Where the mock centres the first page: the landscape print at (16.76, 35.32) 245×183,
// the portrait print at (44.39, 11.34) 167×220. A fitted print of any ratio is centred
// on the same point for its orientation; a sheet (audio) takes the portrait's.
const MEDIA_ANCHOR = { landscape: { x: 16.76 + 245.003 / 2, y: 35.32 + 183.002 / 2 }, portrait: { x: 44.39 + 167 / 2, y: 11.34 + 220 / 2 } };

export function StackComposition({ front }: { front: LabArtifact }) {
  if (isMedia(front)) {
    const print = treatmentOf(front) === "media" ? fitPrint(front, STACK_BOX) : null;
    const size = print ?? { width: 180, height: 216 };
    const anchor = print && !isPortrait(front) ? MEDIA_ANCHOR.landscape : MEDIA_ANCHOR.portrait;
    const left = anchor.x - size.width / 2;
    const top = Math.min(Math.max(anchor.y - size.height / 2, 0), MEDIA_HEIGHT - size.height);
    return (
      <div className="relative shrink-0" style={{ width: Math.max(MEDIA_BACKING_WIDTH, left + size.width), height: MEDIA_HEIGHT }}>
        {MEDIA_BACKING.map((sheet) => (
          <BackingSheet key={sheet.src + sheet.rotate} {...sheet} />
        ))}
        <Front artifact={front} print={print ?? undefined} style={{ position: "absolute", left, top }} />
      </div>
    );
  }
  return (
    <div className="relative shrink-0" style={{ width: 254.253, height: 241.044 }}>
      {SHEET_BACKING.map((sheet) => (
        <BackingSheet key={sheet.src} {...sheet} />
      ))}
      <div
        data-rotate
        data-spread={LANDSCAPE_SHEET.spread}
        aria-hidden
        className="absolute"
        style={{
          left: LANDSCAPE_SHEET.centre.x - LANDSCAPE_SHEET.width / 2,
          top: LANDSCAPE_SHEET.centre.y - LANDSCAPE_SHEET.height / 2,
          width: LANDSCAPE_SHEET.width,
          height: LANDSCAPE_SHEET.height,
          borderRadius: "var(--v1-sheet-radius)",
          background: "var(--v1-paper)",
          boxShadow: "inset 0 0 0 1px var(--v1-sheet-stroke), var(--v1-shadow-print)",
          "--v1-base": `${LANDSCAPE_SHEET.rotate}deg`,
        } as CSSProperties}
      />
      <Front artifact={front} style={{ position: "absolute", left: 37.13, top: 25.04 }} />
    </div>
  );
}
