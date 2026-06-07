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

const BASE_X = 11; // resting x of the vertical line (close to the content)
const ON_FADE = 26; // short fade-in that ENDS on the node (no stub above it)
const OFF_FADE = 90; // fade-out length before a group's bottom
const OFF_TAIL = 12; // transparent tail at a group's bottom

type Node = { x: number; y: number };
type Group = { firstNodeY: number; bottom: number };

function railPath(nodes: Node[], height: number): string {
  let d = `M ${BASE_X} 0`;
  for (const n of nodes) {
    const ax = Math.max(BASE_X, n.x); // bow apex (out to the node)
    d += ` L ${BASE_X} ${(n.y - 30).toFixed(1)}`;
    d += ` C ${BASE_X} ${(n.y - 15).toFixed(1)}, ${ax} ${(n.y - 16).toFixed(1)}, ${ax} ${n.y.toFixed(1)}`;
    d += ` C ${ax} ${(n.y + 16).toFixed(1)}, ${BASE_X} ${(n.y + 15).toFixed(1)}, ${BASE_X} ${(n.y + 30).toFixed(1)}`;
  }
  d += ` L ${BASE_X} ${height}`;
  return d;
}

// Each group's line is OFF until its first node, turns solid AT the node, runs
// through the group, then fades out before the group's bottom. The gaps between
// groups are the line-breaks. (No faded stub above a group's node.)
function gradientStops(height: number, groups: Group[]): { o: number; op: number }[] {
  if (!height) return [];
  const pts: { o: number; op: number }[] = [{ o: 0, op: 0 }];
  for (const g of groups) {
    const s = g.firstNodeY;
    const e = g.bottom;
    pts.push({ o: (s - ON_FADE) / height, op: 0 });
    pts.push({ o: s / height, op: 0.92 });
    pts.push({ o: Math.max(s + 1, e - OFF_FADE) / height, op: 0.92 });
    pts.push({ o: (e - OFF_TAIL) / height, op: 0 });
  }
  pts.push({ o: 1, op: 0 });
  return pts
    .map((p) => ({ o: Math.max(0, Math.min(1, p.o)), op: p.op }))
    .sort((a, b) => a.o - b.o);
}

function RailSvg({ rootRef }: { rootRef: React.RefObject<HTMLDivElement | null> }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const measure = () => {
      const root = rootRef.current;
      const box = boxRef.current;
      if (!root || !box) return;
      const br = box.getBoundingClientRect();
      const h = root.offsetHeight;
      const ns = Array.from(root.querySelectorAll<HTMLElement>("[data-rail-bow]"))
        .map((n) => {
          const r = n.getBoundingClientRect();
          return { x: r.left - br.left + r.width / 2, y: r.top - br.top + r.height / 2 };
        })
        .filter((n) => n.y >= 0)
        .sort((a, b) => a.y - b.y);
      // one rail run per group: from its first node down to its bottom
      const gs: Group[] = Array.from(root.querySelectorAll<HTMLElement>("[data-rail-group]"))
        .map((g) => {
          const gr = g.getBoundingClientRect();
          const ys = Array.from(g.querySelectorAll<HTMLElement>("[data-rail-bow]")).map(
            (n) => n.getBoundingClientRect().top - br.top + n.getBoundingClientRect().height / 2,
          );
          const top = gr.top - br.top;
          return { firstNodeY: ys.length ? Math.min(...ys) : top + 70, bottom: gr.bottom - br.top };
        })
        .filter((g) => g.bottom > 0);
      setSize({ w: br.width, h });
      setNodes(ns);
      setGroups(gs);
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

  const stops = gradientStops(size.h, groups);

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
              <linearGradient id="rail-fade" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={size.h}>
                {stops.map((s, i) => (
                  <stop key={i} offset={`${(s.o * 100).toFixed(3)}%`} stopColor="#f97316" stopOpacity={s.op} />
                ))}
              </linearGradient>
            </defs>
            <path
              d={railPath(nodes, size.h)}
              stroke="url(#rail-fade)"
              strokeWidth="2"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
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
    <span className="relative flex size-9 items-center justify-center rounded-full border border-[#f97316] bg-[#f97316] text-white shadow-[0_0_14px_2px_rgba(249,115,22,0.4),0_0_0_5px_rgba(249,115,22,0.09)]">
      <span className="pointer-events-none absolute -inset-1.5 rounded-full bg-[#f97316]/20 blur-md" aria-hidden />
      <Icon className="relative size-4" />
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
      <span data-rail-bow className="absolute left-1.5 top-0 z-20 -translate-x-1/2">
        <GroupNode icon={icon} />
      </span>
      <div className="pl-11 md:pl-14">
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
      <span data-rail-bow className="absolute left-1.5 top-0 z-20 -translate-x-1/2">
        <GroupNode icon={icon} />
      </span>
      <div className="pl-11 md:pl-14">
        {kicker && (
          <p className="mb-3 font-mono text-[12px] font-semibold uppercase tracking-[0.16em] text-[#f97316]">{kicker}</p>
        )}
        {children}
      </div>
    </div>
  );
}
