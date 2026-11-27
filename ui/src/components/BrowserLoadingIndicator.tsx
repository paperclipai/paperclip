import { createContext, useContext, useEffect, useRef, useState } from "react";
import { QueryClientContext, useIsMutating, type QueryClient } from "@tanstack/react-query";
import { useLocation } from "@/lib/router";
import { notifyRouteChange, useActivityLoading } from "@/lib/activity-loader";
import { AnimatedPaperclipIcon } from "./AnimatedPaperclipIcon";

const FallbackQueryClientContext = createContext<QueryClient | undefined>(undefined);

function QueryMutatingTracker({ onChange }: { onChange: (count: number) => void }) {
  const mutatingCount = useIsMutating();
  useEffect(() => {
    onChange(mutatingCount);
  }, [mutatingCount, onChange]);
  return null;
}

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

let cachedSpinnerKey: string | null = null;
let cachedSpinnerFrames: string[] = [];

function readNumberToken(rootStyles: CSSStyleDeclaration, token: string): number {
  const raw = Number.parseFloat(rootStyles.getPropertyValue(token).trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function resolveFaviconTokens(rootStyles: CSSStyleDeclaration) {
  const baseFontSize = Number.parseFloat(rootStyles.fontSize) || 16;
  const size = readNumberToken(rootStyles, "--spinner-favicon-size") || baseFontSize * 2;
  const strokeWidth = readNumberToken(rootStyles, "--spinner-favicon-stroke") || Math.max(2, Math.round(size / 8));
  const radius = readNumberToken(rootStyles, "--spinner-favicon-radius") || (size / 2 - strokeWidth);
  const trackAlpha = readNumberToken(rootStyles, "--spinner-favicon-track-opacity") || 0.35;
  const trackColor = rootStyles.getPropertyValue("--muted-foreground").trim() || "GrayText";
  const activeColor = rootStyles.getPropertyValue("--primary").trim() || "Highlight";
  return { size, radius, strokeWidth, trackAlpha, trackColor, activeColor };
}

export function buildFaviconSpinnerFrames(): string[] {
  if (typeof document === "undefined") return [];
  try {
    const rootStyles = window.getComputedStyle(document.documentElement);
    const { size, radius, strokeWidth, trackAlpha, trackColor, activeColor } = resolveFaviconTokens(rootStyles);
    const cacheKey = `${trackColor}|${activeColor}|${size}|${radius}|${strokeWidth}|${trackAlpha}`;
    if (cachedSpinnerKey === cacheKey && cachedSpinnerFrames.length > 0) {
      return cachedSpinnerFrames;
    }

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];

    const frames: string[] = [];
    for (let i = 0; i < SPINNER_FRAME_COUNT; i += 1) {
      const startAngle = ((i / SPINNER_FRAME_COUNT) * Math.PI * 2) - Math.PI / 2;
      ctx.clearRect(0, 0, size, size);

      ctx.save();
      ctx.globalAlpha = trackAlpha;
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
      ctx.strokeStyle = trackColor;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(size / 2, size / 2, radius, startAngle, startAngle + Math.PI * 1.25);
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = "round";
      ctx.stroke();

      frames.push(canvas.toDataURL("image/png"));
    }
    cachedSpinnerKey = cacheKey;
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
  const queryClient = useContext(QueryClientContext ?? FallbackQueryClientContext);
  const [mutatingCount, setMutatingCount] = useState(0);
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

  const effectiveMutatingCount = queryClient ? mutatingCount : 0;
  const rawLoading = activity.isLoading || effectiveMutatingCount > 0 || routeSweeping;
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
      {queryClient ? <QueryMutatingTracker onChange={setMutatingCount} /> : null}
      <div
        aria-hidden="true"
        data-testid="browser-loading-bar"
        className="pointer-events-none fixed inset-x-0 top-0 z-(--z-200) h-0.5 overflow-hidden transition-opacity duration-200"
        style={{ opacity: barVisible ? 1 : 0 }}
      >
        <div
          className="paperclip-browser-progress-fill h-full bg-gradient-to-r from-primary/60 via-primary to-ring transition-[width] duration-150 ease-out"
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
