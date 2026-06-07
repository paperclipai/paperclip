import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * StoryRail — a reusable left-margin "thread" that stitches a page into one story.
 *
 * - <PageRail> draws ONE continuous vertical line down the left of the content
 *   column and fills it (orange) as you scroll. Wrap the whole page body in it.
 * - <RailGroup> hangs a big labelled node on that line = one story / chapter.
 * - <RailMini> nests a smaller node under a group on its own sub-rail = a
 *   mini-story inside the group. A group can hold many minis.
 *
 * Alignment: the line sits at the content column's left padding (left-6 inside
 * a centered max-w-6xl px-6). Group nodes are placed at the same x; their bodies
 * get left padding to clear it. Minis run on a short sub-rail indented to the right.
 */

type IconType = ComponentType<{ className?: string }>;

function reduceMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ── The page thread — an SVG line that bows out to each node ───────────────────

const BASE_X = 7; // resting x of the vertical line (in the left gutter)

type Seg = { y0: number; y1: number; nodes: { x: number; y: number }[] };

// One continuous line down the whole page, bowing out to each node, fading
// only at the very top and bottom.
function buildSegments(nodes: { x: number; y: number }[], height: number): Seg[] {
  if (!height) return [];
  return [{ y0: 0, y1: height, nodes }];
}

function railPath(seg: Seg): string {
  const { y0, y1, nodes } = seg;
  let d = `M ${BASE_X} ${y0}`;
  for (const n of nodes) {
    const ax = Math.max(BASE_X, n.x); // bow apex (out to the node)
    d += ` L ${BASE_X} ${(n.y - 26).toFixed(1)}`;
    d += ` C ${BASE_X} ${(n.y - 13).toFixed(1)}, ${ax} ${(n.y - 13).toFixed(1)}, ${ax} ${n.y.toFixed(1)}`;
    d += ` C ${ax} ${(n.y + 13).toFixed(1)}, ${BASE_X} ${(n.y + 13).toFixed(1)}, ${BASE_X} ${(n.y + 26).toFixed(1)}`;
  }
  d += ` L ${BASE_X} ${y1}`;
  return d;
}

function RailSvg({ rootRef }: { rootRef: React.RefObject<HTMLDivElement | null> }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [segs, setSegs] = useState<Seg[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const measure = () => {
      const root = rootRef.current;
      const box = boxRef.current;
      if (!root || !box) return;
      const br = box.getBoundingClientRect();
      const h = root.offsetHeight;
      const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-rail-bow]"))
        .map((n) => {
          const r = n.getBoundingClientRect();
          return { x: r.left - br.left + r.width / 2, y: r.top - br.top + r.height / 2 };
        })
        .filter((n) => n.y >= 0)
        .sort((a, b) => a.y - b.y);
      setSize({ w: br.width, h });
      setSegs(buildSegments(nodes, h));
    };
    measure();
    const root = rootRef.current;
    const ro = new ResizeObserver(measure);
    if (root) ro.observe(root);
    window.addEventListener("resize", measure);
    const t1 = setTimeout(measure, 250);
    const t2 = setTimeout(measure, 1200); // after fonts/images settle
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [rootRef]);

  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
      <div ref={boxRef} className="mx-auto h-full max-w-6xl">
        {size.h > 0 && (
          <svg
            className="h-full w-full overflow-visible"
            width={size.w}
            height={size.h}
            viewBox={`0 0 ${size.w || 1} ${size.h}`}
            preserveAspectRatio="none"
            fill="none"
          >
            <defs>
              {segs.map((s, i) => {
                const span = Math.max(1, s.y1 - s.y0);
                const f = Math.min(0.45, 130 / span); // ~130px fade at each end
                return (
                  <linearGradient key={i} id={`rail-fade-${i}`} gradientUnits="userSpaceOnUse" x1="0" y1={s.y0} x2="0" y2={s.y1}>
                    <stop offset="0%" stopColor="#f97316" stopOpacity="0" />
                    <stop offset={`${(f * 100).toFixed(2)}%`} stopColor="#f97316" stopOpacity="0.8" />
                    <stop offset={`${((1 - f) * 100).toFixed(2)}%`} stopColor="#fb923c" stopOpacity="0.8" />
                    <stop offset="100%" stopColor="#fb923c" stopOpacity="0" />
                  </linearGradient>
                );
              })}
            </defs>
            {segs.map((s, i) => (
              <path
                key={i}
                d={railPath(s)}
                stroke={`url(#rail-fade-${i})`}
                strokeWidth="1.6"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}

export function PageRail({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="relative">
      <RailSvg rootRef={ref} />
      <div className="relative z-10">{children}</div>
    </div>
  );
}

// ── Nodes ─────────────────────────────────────────────────────────────────────

function GroupNode({ icon: Icon }: { icon: IconType }) {
  return (
    <span className="relative flex size-11 items-center justify-center rounded-full border border-[#f97316] bg-[#f97316] text-white shadow-[0_0_18px_3px_rgba(249,115,22,0.45),0_0_0_6px_rgba(249,115,22,0.10)]">
      <span className="pointer-events-none absolute -inset-2 rounded-full bg-[#f97316]/25 blur-md" aria-hidden />
      <Icon className="relative size-5" />
    </span>
  );
}

// ── Group = one story on the thread ───────────────────────────────────────────

export function RailGroup({
  icon,
  kicker,
  title,
  intro,
  children,
}: {
  icon: IconType;
  kicker?: string;
  title: string;
  intro?: string;
  children?: ReactNode;
}) {
  return (
    <div className="relative">
      {/* big node on the main thread */}
      <span data-rail-bow className="absolute left-0 top-0 z-20 -translate-x-1/2">
        <GroupNode icon={icon} />
      </span>
      <div className="pl-14 md:pl-20">
        {kicker && (
          <p className="font-mono text-[12px] font-semibold uppercase tracking-[0.16em] text-[#f97316]">{kicker}</p>
        )}
        <h3 className="mt-1 text-[clamp(22px,2.6vw,30px)] font-bold tracking-[-0.02em] text-gray-900 dark:text-neutral-100">
          {title}
        </h3>
        {intro && (
          <p className="mt-2 max-w-xl text-[15.5px] leading-relaxed text-gray-500 dark:text-neutral-400">{intro}</p>
        )}
        {children && <div className="mt-9 space-y-12">{children}</div>}
      </div>
    </div>
  );
}

// ── Mini-story = nested beat under a group ────────────────────────────────────

export function RailMini({
  num,
  title,
  desc,
  visual,
}: {
  num?: string;
  title: string;
  desc: string;
  visual?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (reduceMotion()) {
      setSeen(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className="relative">
      <div
        className={cn(
          "transition-all duration-700 md:grid md:grid-cols-2 md:items-center md:gap-9",
          seen ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
        )}
      >
        <div>
          {num && <span className="font-mono text-[12px] font-semibold text-[#f97316]">{num}</span>}
          <h4 className="mt-0.5 text-[19px] font-bold tracking-[-0.01em] text-gray-900 dark:text-neutral-100">
            {title}
          </h4>
          <p className="mt-1.5 max-w-md text-[14.5px] leading-relaxed text-gray-500 dark:text-neutral-400">{desc}</p>
        </div>
        {visual && <div className="mt-4 md:mt-0">{visual}</div>}
      </div>
    </div>
  );
}

// ── Simple section node (a group head with no minis) ──────────────────────────

export function RailHead({
  icon,
  kicker,
  children,
}: {
  icon: IconType;
  kicker?: string;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <span data-rail-bow className="absolute left-0 top-0 z-20 -translate-x-1/2">
        <GroupNode icon={icon} />
      </span>
      <div className="pl-14 md:pl-20">
        {kicker && (
          <p className="mb-3 font-mono text-[12px] font-semibold uppercase tracking-[0.16em] text-[#f97316]">{kicker}</p>
        )}
        {children}
      </div>
    </div>
  );
}
