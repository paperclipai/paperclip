import { useCallback, useEffect, useRef, useState } from "react";
import { DIRECTION_IDS, KIT_META, type DirectionId } from "../kit";
import { labSearch, type LabTheme, type LabView } from "../lab-state";

/**
 * The contact sheet. Every tile is this same page in an iframe (`chrome=0`),
 * laid out at the lab's target viewport width and scaled down with CSS, so a
 * tile is the real view at reduced size and never a second implementation.
 */

// The viewport every surface is designed against.
const FRAME_WIDTH = 1440;
const FRAME_MIN_HEIGHT = 900;

const LABEL = "font-mono text-(length:--text-nano) uppercase tracking-(--tracking-label) text-muted-foreground";

interface TileProps {
  direction: DirectionId;
  view: LabView;
  theme: LabTheme;
  anim: boolean;
  /** Crops a long view (the pane lists 21 cards) so a row stays comparable. Frame px, before scaling. */
  maxHeight?: number;
}

function Tile({ direction, view, theme, anim, maxHeight }: TileProps) {
  const wrapRef = useRef<HTMLAnchorElement>(null);
  const contentObserver = useRef<ResizeObserver | null>(null);
  const [scale, setScale] = useState(0);
  const [height, setHeight] = useState(FRAME_MIN_HEIGHT);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / FRAME_WIDTH));
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => contentObserver.current?.disconnect(), []);

  // Same origin, so the tile can size itself to the framed page. `#root` is
  // measured rather than the document, whose height follows the iframe's own.
  const onLoad = useCallback((event: React.SyntheticEvent<HTMLIFrameElement>) => {
    const root = event.currentTarget.contentDocument?.getElementById("root");
    if (!root) return;
    const measure = () => setHeight(Math.max(FRAME_MIN_HEIGHT, Math.ceil(root.getBoundingClientRect().height)));
    contentObserver.current?.disconnect();
    contentObserver.current = new ResizeObserver(measure);
    contentObserver.current.observe(root);
    measure();
  }, []);

  const search = labSearch({ direction, view, theme, chrome: false, anim });
  const shown = Math.min(height, maxHeight ?? height);
  return (
    <a
      ref={wrapRef}
      href={labSearch({ direction, view, theme, chrome: true, anim })}
      title={`Open ${KIT_META[direction].name} · ${view}`}
      className="block overflow-hidden rounded-sm border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ height: scale ? shown * scale : undefined }}
    >
      <iframe
        src={search}
        title={`${KIT_META[direction].name} · ${view}`}
        tabIndex={-1}
        scrolling="no"
        onLoad={onLoad}
        className="pointer-events-none block origin-top-left border-0"
        style={{ width: FRAME_WIDTH, height, transform: `scale(${scale})` }}
      />
    </a>
  );
}

function ColumnHead({ children }: { children: string }) {
  return <span className={LABEL}>{children}</span>;
}

/** One kit: its four surfaces side by side. */
function KitBoard({ direction, theme, anim }: { direction: DirectionId; theme: LabTheme; anim: boolean }) {
  const views: LabView[] = ["thread", "panel", "gallery", "stack"];
  return (
    <div className="grid grid-cols-4 items-start gap-4">
      {views.map((view) => (
        <div key={view} className="flex min-w-0 flex-col gap-2">
          <ColumnHead>{view}</ColumnHead>
          <Tile direction={direction} view={view} theme={theme} anim={anim} maxHeight={2 * FRAME_MIN_HEIGHT} />
        </div>
      ))}
    </div>
  );
}

/** Every kit: one row each, one column per surface. */
function AllBoard({ theme, anim }: { theme: LabTheme; anim: boolean }) {
  return (
    <div className="grid grid-cols-(--gtc-board) items-start gap-x-4 gap-y-8" style={{ "--gtc-board": "7rem repeat(3, minmax(0, 1fr))" } as React.CSSProperties}>
      <span />
      <ColumnHead>Thread</ColumnHead>
      <ColumnHead>Panel</ColumnHead>
      <ColumnHead>Gallery + stack</ColumnHead>
      {DIRECTION_IDS.map((direction) => (
        <div key={direction} className="contents">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-foreground">{KIT_META[direction].name}</span>
            <span className="text-xs text-muted-foreground">{KIT_META[direction].tagline}</span>
          </div>
          <Tile direction={direction} view="thread" theme={theme} anim={anim} maxHeight={2 * FRAME_MIN_HEIGHT} />
          <Tile direction={direction} view="panel" theme={theme} anim={anim} maxHeight={2 * FRAME_MIN_HEIGHT} />
          <div className="flex min-w-0 flex-col gap-4">
            <Tile direction={direction} view="gallery" theme={theme} anim={anim} maxHeight={FRAME_MIN_HEIGHT} />
            <Tile direction={direction} view="stack" theme={theme} anim={anim} maxHeight={FRAME_MIN_HEIGHT} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Board({ direction, theme, anim }: { direction: DirectionId | "all"; theme: LabTheme; anim: boolean }) {
  return (
    <div className="flex min-h-225 flex-col gap-6 bg-background p-6 text-foreground">
      <header className="flex flex-col gap-1">
        <p className={LABEL}>Contact sheet · {theme}</p>
        <h1 className="text-lg font-semibold">{direction === "all" ? "All directions" : KIT_META[direction].name}</h1>
      </header>
      {direction === "all" ? <AllBoard theme={theme} anim={anim} /> : <KitBoard direction={direction} theme={theme} anim={anim} />}
    </div>
  );
}
