import type { CSSProperties } from "react";
import type { LabRecord } from "../../kit";

const BOX = { width: 168, height: 150 };
const SHEET = { width: 112, height: 134 };
const FRONT = { left: (BOX.width - SHEET.width) / 2, top: 8 };
const BACKINGS = [
  { spread: "left", rotate: -14, left: FRONT.left - 14, top: FRONT.top + 4 },
  { spread: "right", rotate: -5, left: FRONT.left + 14, top: FRONT.top + 4 },
] as const;

type Backing = (typeof BACKINGS)[number];

function BackingSheet({ spread, rotate, left, top }: Backing) {
  const style = {
    left,
    top,
    width: SHEET.width,
    height: SHEET.height,
    transformOrigin: `${SHEET.width / 2}px ${SHEET.height / 2}px`,
    filter: "var(--workspace-shadow-sheet)",
    "--workspace-base": `${rotate}deg`,
  } as CSSProperties;
  return <div data-rotate data-spread={spread} aria-hidden className="absolute rounded-(--workspace-sheet-radius) bg-(--workspace-paper)" style={style} />;
}

export function MotionSpecimen({ item }: { item: LabRecord }) {
  return (
    <button
      type="button"
      aria-label={`Open ${item.title}`}
      className="flex h-(--workspace-tile-h) w-full flex-col items-center gap-3 rounded-(--workspace-tile-radius) px-4 pt-4 text-left outline-none transition-colors hover:bg-(--workspace-tile-hover) focus-visible:bg-(--workspace-tile-hover) focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="relative shrink-0" style={{ width: BOX.width, height: BOX.height }}>
        {BACKINGS.map((backing) => (
          <BackingSheet key={backing.spread} {...backing} />
        ))}
        <div
          data-front
          className="absolute flex items-end rounded-(--workspace-sheet-radius) bg-(--workspace-paper) p-2 text-(length:--text-micro) leading-4 text-(--workspace-ink)"
          style={{ left: FRONT.left, top: FRONT.top, width: SHEET.width, height: SHEET.height, filter: "var(--workspace-shadow-sheet)" }}
        >
          <span className="line-clamp-3 break-words">{item.title}</span>
        </div>
      </div>
      <span className="line-clamp-2 w-full text-center text-sm font-medium leading-5 text-foreground">{item.title}</span>
      <span className="text-xs leading-4 text-muted-foreground">
        {item.author} · {item.updatedLabel}
      </span>
    </button>
  );
}
