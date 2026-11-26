import { useEffect, useRef, useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { useLocation } from "@/lib/router";
import { notifyRouteChange, useActivityLoading } from "@/lib/activity-loader";
import { AnimatedPaperclipIcon } from "./AnimatedPaperclipIcon";

const SPINNER_FRAME_COUNT = 12;
const SPINNER_INTERVAL_MS = 70;
const ROUTE_SWEEP_MIN_MS = 260;
const SUSTAINED_LOADING_DELAY_MS = 120;

interface SavedFaviconEntry {
  rel: string;
  href: string;
  type: string | null;
  sizes: string | null;
}

let cachedSpinnerFrames: string[] | null = null;

function buildFaviconSpinnerFrames(): string[] {
  if (cachedSpinnerFrames) return cachedSpinnerFrames;
  if (typeof document === "undefined") return [];
  try {
    const size = 32;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];

    const rootStyles = window.getComputedStyle(document.documentElement);
    const trackColor = rootStyles.getPropertyValue("--muted-foreground").trim() || "GrayText";
    const activeColor = rootStyles.getPropertyValue("--primary").trim() || "Highlight";

    const frames: string[] = [];
    for (let i = 0; i < SPINNER_FRAME_COUNT; i += 1) {
      const startAngle = ((i / SPINNER_FRAME_COUNT) * Math.PI * 2) - Math.PI / 2;
      ctx.clearRect(0, 0, size, size);

      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, 11.5, 0, Math.PI * 2);
      ctx.strokeStyle = trackColor;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(size / 2, size / 2, 11.5, startAngle, startAngle + Math.PI * 1.25);
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.stroke();

      frames.push(canvas.toDataURL("image/png"));
    }
    cachedSpinnerFrames = frames;
    return frames;
  } catch {
    return [];
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function useBrowserTabSpinner(active: boolean) {
  const savedIconsRef = useRef<SavedFaviconEntry[] | null>(null);

  useEffect(() => {
    if (typeof document === "undefined" || !document.head) return;

    const restoreIcons = () => {
      document.head
        .querySelectorAll('link[data-paperclip-loading-favicon="true"]')
        .forEach((node) => node.remove());
      const saved = savedIconsRef.current;
      if (!saved) return;
      savedIconsRef.current = null;
      for (const entry of saved) {
        const link = document.createElement("link");
        link.rel = entry.rel;
        link.href = entry.href;
        if (entry.type) link.type = entry.type;
        if (entry.sizes) link.setAttribute("sizes", entry.sizes);
        document.head.appendChild(link);
      }
    };

    if (!active) {
      restoreIcons();
      return;
    }

    const frames = buildFaviconSpinnerFrames();
    if (frames.length === 0) return;

    if (!savedIconsRef.current) {
      const existing = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))
        .filter((el) => el.getAttribute("data-paperclip-loading-favicon") !== "true");
      savedIconsRef.current = existing.map((el) => ({
        rel: el.getAttribute("rel") || "icon",
        href: el.getAttribute("href") || "",
        type: el.getAttribute("type"),
        sizes: el.getAttribute("sizes"),
      }));
      existing.forEach((el) => el.remove());
    }

    const spinnerLink = document.createElement("link");
    spinnerLink.rel = "icon";
    spinnerLink.type = "image/png";
    spinnerLink.setAttribute("data-paperclip-loading-favicon", "true");
    let frameIndex = 0;
    spinnerLink.href = frames[0]!;
    document.head.appendChild(spinnerLink);

    if (prefersReducedMotion()) {
      return restoreIcons;
    }

    const timer = window.setInterval(() => {
      frameIndex = (frameIndex + 1) % frames.length;
      spinnerLink.href = frames[frameIndex]!;
    }, SPINNER_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      restoreIcons();
    };
  }, [active]);
}

export function BrowserLoadingIndicator() {
  const location = useLocation();
  const mutatingCount = useIsMutating();
  const activity = useActivityLoading();
  const [routeSweeping, setRouteSweeping] = useState(false);
  const mountedLocationRef = useRef<string | null>(null);

  useEffect(() => {
    const key = `${location.pathname}${location.search}`;
    if (mountedLocationRef.current === null) {
      mountedLocationRef.current = key;
      return;
    }
    if (mountedLocationRef.current === key) return;
    mountedLocationRef.current = key;
    notifyRouteChange(1_200);
    setRouteSweeping(true);
    const timer = window.setTimeout(() => setRouteSweeping(false), ROUTE_SWEEP_MIN_MS);
    return () => window.clearTimeout(timer);
  }, [location.pathname, location.search]);

  const rawLoading = activity.isLoading || mutatingCount > 0 || routeSweeping;
  const [sustainedLoading, setSustainedLoading] = useState(false);
  const [barVisible, setBarVisible] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!rawLoading) {
      setSustainedLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setSustainedLoading(true), SUSTAINED_LOADING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [rawLoading]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("paperclip-browser-loading", sustainedLoading);
    return () => {
      document.documentElement.classList.remove("paperclip-browser-loading");
    };
  }, [sustainedLoading]);

  useBrowserTabSpinner(rawLoading || barVisible);

  useEffect(() => {
    if (rawLoading) {
      setBarVisible(true);
      setProgress((current) => (current > 0 && current < 95 ? current : 18));
      const step = window.setInterval(() => {
        setProgress((current) => {
          if (current >= 88) return current;
          const delta = Math.max(2, (88 - current) * 0.22);
          return Math.min(88, current + delta);
        });
      }, 120);
      return () => window.clearInterval(step);
    }

    if (!barVisible) return;
    setProgress(100);
    const fadeTimer = window.setTimeout(() => {
      setBarVisible(false);
      setProgress(0);
    }, 220);
    return () => window.clearTimeout(fadeTimer);
  }, [rawLoading, barVisible]);

  return (
    <>
      <div
        aria-hidden="true"
        data-testid="browser-loading-bar"
        className="pointer-events-none fixed inset-x-0 top-0 z-(--z-200) h-0.5 overflow-hidden transition-opacity duration-200"
        style={{ opacity: barVisible ? 1 : 0 }}
      >
        <div
          className="paperclip-browser-progress-fill h-full bg-gradient-to-r from-sky-500 via-primary to-cyan-400 transition-[width] duration-150 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
      {sustainedLoading ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="browser-loading-pill"
          className="paperclip-loading-pill pointer-events-none fixed left-1/2 top-2.5 z-(--z-200) flex -translate-x-1/2 items-center gap-2 rounded-full border border-border/80 bg-background/95 px-3 py-1 text-xs font-medium text-foreground shadow-md backdrop-blur"
        >
          <AnimatedPaperclipIcon className="size-3.5 text-primary" />
          <span className="paperclip-inline-spinner" aria-hidden="true" />
          <span>Loading…</span>
        </div>
      ) : null}
    </>
  );
}
