export default () => `import { useCallback, useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";
import { DIRECTION_IDS, KIT_META, SURFACE_IDS, surfaceOf, type DirectionId, type SurfaceId } from "../kit";
import { labSearch, type LabTheme, type LabView } from "../lab-state";

const FRAME_WIDTH = 1440;
const FRAME_MIN_HEIGHT = 900;

const LABEL = "font-mono text-(length:--text-nano) uppercase tracking-(--tracking-label) text-muted-foreground";

interface Toggles {
  theme: LabTheme;
  anim: boolean;
  proposal: boolean;
}

interface TileProps extends Toggles {
  direction: DirectionId;
  view: SurfaceId;
  maxHeight?: number;
}

function Tile({ direction, view, theme, anim, proposal, maxHeight }: TileProps) {
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

  const onLoad = useCallback((event: SyntheticEvent<HTMLIFrameElement>) => {
    const root = event.currentTarget.contentDocument?.getElementById("root");
    if (!root) return;
    const measure = () => setHeight(Math.max(FRAME_MIN_HEIGHT, Math.ceil(root.getBoundingClientRect().height)));
    contentObserver.current?.disconnect();
    contentObserver.current = new ResizeObserver(measure);
    contentObserver.current.observe(root);
    measure();
  }, []);

  const search = labSearch({ direction, view, theme, chrome: false, anim, proposal });
  const shown = Math.min(height, maxHeight ?? height);
  return (
    <a
      ref={wrapRef}
      href={labSearch({ direction, view, theme, chrome: true, anim, proposal })}
      title={\`Open \${KIT_META[direction].name} · \${view}\`}
      className="block overflow-hidden rounded-sm border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ height: scale ? shown * scale : undefined }}
    >
      <iframe
        src={search}
        title={\`\${KIT_META[direction].name} · \${view}\`}
        tabIndex={-1}
        scrolling="no"
        onLoad={onLoad}
        className="pointer-events-none block origin-top-left border-0"
        style={{ width: FRAME_WIDTH, height, transform: \`scale(\${scale})\` }}
      />
    </a>
  );
}

function ColumnHead({ children }: { children: string }) {
  return <span className={LABEL}>{children}</span>;
}

const columns = (count: number, head: string) => ({ "--gtc-board": \`\${head}repeat(\${count}, minmax(0, 1fr))\` }) as CSSProperties;

function KitBoard({ direction, ...toggles }: Toggles & { direction: DirectionId }) {
  return (
    <div className="grid grid-cols-(--gtc-board) items-start gap-4" style={columns(SURFACE_IDS.length, "")}>
      {SURFACE_IDS.map((view) => (
        <div key={view} className="flex min-w-0 flex-col gap-2">
          <ColumnHead>{surfaceOf(view).label}</ColumnHead>
          <Tile direction={direction} view={view} {...toggles} maxHeight={2 * FRAME_MIN_HEIGHT} />
        </div>
      ))}
    </div>
  );
}

function AllBoard({ view, ...toggles }: Toggles & { view: LabView }) {
  const surfaces: readonly SurfaceId[] = view === "board" ? SURFACE_IDS : [view];
  return (
    <div className="grid grid-cols-(--gtc-board) items-start gap-x-4 gap-y-8" style={columns(surfaces.length, "7rem ")}>
      <span />
      {surfaces.map((surface) => (
        <ColumnHead key={surface}>{surfaceOf(surface).label}</ColumnHead>
      ))}
      {DIRECTION_IDS.map((direction) => (
        <div key={direction} className="contents">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-foreground">{KIT_META[direction].name}</span>
            <span className="text-xs text-muted-foreground">{KIT_META[direction].tagline}</span>
          </div>
          {surfaces.map((surface) => (
            <Tile key={surface} direction={direction} view={surface} {...toggles} maxHeight={2 * FRAME_MIN_HEIGHT} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Board({ direction, view, ...toggles }: Toggles & { direction: DirectionId | "all"; view: LabView }) {
  return (
    <div className="flex min-h-225 flex-col gap-6 bg-background p-6 text-foreground">
      <header className="flex flex-col gap-1">
        <p className={LABEL}>Contact sheet · {toggles.theme}</p>
        <h1 className="text-lg font-semibold">{direction === "all" ? "All directions" : KIT_META[direction].name}</h1>
      </header>
      {direction === "all" ? <AllBoard view={view} {...toggles} /> : <KitBoard direction={direction} {...toggles} />}
    </div>
  );
}
`;
