import { useEffect, useRef, useState } from "react";
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

// ── The continuous page thread ────────────────────────────────────────────────

export function PageRail({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(0);

  useEffect(() => {
    if (reduceMotion()) {
      setP(1);
      return;
    }
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const anchor = window.innerHeight * 0.5;
        // progress of the page body past the viewport mid-line
        setP(Math.max(0, Math.min(1, (anchor - r.top) / Math.max(1, r.height - window.innerHeight * 0.6))));
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={ref} className="relative">
      {/* line overlay — sits at the content column's left padding */}
      <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
        <div className="mx-auto h-full max-w-6xl px-6">
          <div className="relative h-full">
            <div className="absolute left-0 top-0 h-full w-px bg-black/[0.07] dark:bg-white/[0.09]" />
            <div
              className="absolute left-0 top-0 w-px bg-gradient-to-b from-[#f97316] via-[#fb923c] to-[#f97316]/30"
              style={{ height: `${p * 100}%` }}
            />
          </div>
        </div>
      </div>
      <div className="relative z-10">{children}</div>
    </div>
  );
}

// ── Nodes ─────────────────────────────────────────────────────────────────────

function GroupNode({ icon: Icon }: { icon: IconType }) {
  return (
    <span className="flex size-11 items-center justify-center rounded-full border border-[#f97316] bg-[#f97316] text-white shadow-[0_0_0_6px_rgba(249,115,22,0.10)]">
      <Icon className="size-5" />
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
      <span className="absolute left-0 top-0 z-20 -translate-x-1/2">
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
        {children && (
          <div className="relative mt-9">
            {/* sub-rail for the mini-stories */}
            <div className="pointer-events-none absolute bottom-8 left-2 top-1 w-px bg-[#f97316]/25 dark:bg-[#f97316]/30" />
            <div className="space-y-12">{children}</div>
          </div>
        )}
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
    <div ref={ref} className="relative pl-9">
      {/* small node on the sub-rail + horizontal tick */}
      <span className="absolute left-2 top-1.5 z-10 size-3 -translate-x-1/2 rounded-full bg-[#f97316] ring-4 ring-[#f97316]/15" />
      <span className="pointer-events-none absolute left-2 top-3 h-px w-5 bg-[#f97316]/25" aria-hidden />
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
      <span className="absolute left-0 top-0 z-20 -translate-x-1/2">
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
