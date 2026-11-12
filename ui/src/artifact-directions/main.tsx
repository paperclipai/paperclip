import { Component, StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CompanyProvider } from "@/context/CompanyContext";
import { ThemeProvider, useTheme } from "@/context/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import "../index.css";
import "./lab.css";
import { installApiStub } from "./api-stub";
import { DIRECTION_IDS, KIT_KEYS, KIT_META, loadKit, type DirectionId, type DirectionKit } from "./kit";
import { kitIdOf, labSearch, readLabState, type LabState, type LabTheme } from "./lab-state";
import { Board } from "./frames/Board";
import { KindsSheet } from "./frames/KindsSheet";
import { LabToolbar } from "./frames/LabToolbar";
import { SurfaceView } from "./frames/SurfaceView";

/**
 * Entry for the artifact-directions lab (see `kit.ts` for the contract and
 * `lab-state.ts` for the URL). Nothing here talks to a server: the stub is
 * installed before anything renders, and the shipped components the Today kit
 * mounts get the same provider stack the app gives them.
 */

installApiStub();

const initial = readLabState(window.location.search);

/** `.dark` on <html> is the theme (index.css:393); ThemeProvider reads it from the document on mount. */
function applyTheme(theme: LabTheme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}
applyTheme(initial.theme);

/** `data-lab-anim="1"` on <html> is what a kit's hover-animation rules key on (see d5-v1-mvp/tokens.css). */
function applyAnim(anim: boolean) {
  if (anim) document.documentElement.dataset.labAnim = "1";
  else delete document.documentElement.dataset.labAnim;
}
applyAnim(initial.anim);

/** Keeps `useTheme()` consumers in step after a toolbar toggle. */
function ThemeSync({ theme }: { theme: LabTheme }) {
  const { theme: current, setTheme } = useTheme();
  useEffect(() => {
    if (current !== theme) setTheme(theme);
  }, [current, setTheme, theme]);
  return null;
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function KitProblem({ id, error }: { id: DirectionId; error: unknown }) {
  return (
    <div role="alert" data-kit-error={id} className="m-6 rounded-md bg-destructive/10 p-4 font-mono text-xs text-destructive">
      {KIT_META[id].name} failed: {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

/** A kit that throws while rendering shows its error in place rather than blanking the lab. */
class KitBoundary extends Component<{ id: DirectionId; children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    return this.state.error ? <KitProblem id={this.props.id} error={this.state.error} /> : this.props.children;
  }
}

type KitState = { id: DirectionId; kit?: DirectionKit; error?: unknown };

/**
 * Resolves the selected kit. While the next kit loads, the one already on
 * screen stays mounted (its id is reported alongside), so switching kits never
 * collapses the page and loses the scroll position.
 */
function useKit(id: DirectionId): KitState {
  const [state, setState] = useState<KitState>({ id });
  useEffect(() => {
    let live = true;
    loadKit(id).then(
      (kit) => live && setState({ id, kit }),
      (error: unknown) => {
        console.error(error);
        if (live) setState({ id, error });
      },
    );
    return () => {
      live = false;
    };
  }, [id]);
  return state.id === id || !state.kit ? state : { id: state.id, kit: state.kit };
}

/**
 * Keeps the viewport where it was across a toolbar change, so a direction,
 * surface or theme can be toggled back and forth to compare the same spot.
 * The scroll offset is captured when the change is requested and put back once
 * the new content has laid out — immediately, on the next frame, and once more
 * after lazy images have had a moment to settle the page height. Browser and
 * pinch zoom need nothing: a toolbar change never reloads the document.
 */
function useScrollKeeper(deps: unknown[]) {
  const pending = useRef<number | null>(null);
  const keep = useCallback(() => {
    pending.current = window.scrollY;
  }, []);
  useLayoutEffect(() => {
    const top = pending.current;
    if (top === null) return;
    const restore = () => window.scrollTo({ top, left: window.scrollX, behavior: "instant" });
    restore();
    const frame = window.requestAnimationFrame(restore);
    const late = window.setTimeout(() => {
      restore();
      if (pending.current === top) pending.current = null;
    }, 200);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(late);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return keep;
}

function Lab() {
  const [state, setState] = useState<LabState>(initial);
  const kitId = kitIdOf(state);
  const { id: shownKitId, kit, error } = useKit(kitId);
  const keepScroll = useScrollKeeper([state, shownKitId]);

  const change = useCallback(
    (patch: Partial<LabState>) => {
      keepScroll();
      setState((current) => {
        const next = { ...current, ...patch };
        window.history.replaceState(null, "", labSearch(next));
        return next;
      });
    },
    [keepScroll],
  );

  useEffect(() => applyTheme(state.theme), [state.theme]);
  useEffect(() => applyAnim(state.anim), [state.anim]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === "t") change({ theme: state.theme === "dark" ? "light" : "dark" });
      if (event.key === "a") change({ anim: !state.anim });
      const direction = DIRECTION_IDS.find((id) => KIT_KEYS[id] === event.key);
      if (direction) change({ direction });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [change, state.theme, state.anim]);

  return (
    <>
      <ThemeSync theme={state.theme} />
      {state.chrome ? <LabToolbar state={state} onChange={change} /> : null}
      {state.view === "board" ? (
        <Board direction={state.direction} theme={state.theme} anim={state.anim} />
      ) : error ? (
        <KitProblem id={kitId} error={error} />
      ) : kit ? (
        <KitBoundary key={shownKitId} id={shownKitId}>
          {state.view === "kinds" ? <KindsSheet kit={kit} /> : <SurfaceView kit={kit} surface={state.view} />}
        </KitBoundary>
      ) : null}
    </>
  );
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <CompanyProvider>
            <TooltipProvider>
              <Lab />
            </TooltipProvider>
          </CompanyProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  </StrictMode>,
);
