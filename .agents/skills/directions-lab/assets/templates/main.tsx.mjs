export default (ctx) => `import { Component, StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AvatarInitialProvider } from "@/components/ui/avatar-initials";
import { useTheme } from "@/context/ThemeContext";
import "../index.css";
import "./lab.css";
import { installApiStub } from "./api-stub";
import "./api-routes";
import { LAB_BUILD } from "./build-info";
import { DIRECTION_IDS, KIT_KEYS, KIT_META, SURFACE_IDS, loadKit, type DirectionId, type DirectionKit } from "./kit";
import { kitIdOf, labSearch, readLabState, type LabState, type LabTheme } from "./lab-state";
import { createLabQueryClient, LabProviders } from "./providers";
import { registry } from "./registry";
import { Board } from "./frames/Board";
import { LabToolbar } from "./frames/LabToolbar";
import { SurfaceView } from "./frames/SurfaceView";

installApiStub();

const initial = readLabState(window.location.search);

function applyTheme(theme: LabTheme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}
applyTheme(initial.theme);

function applyAnim(anim: boolean) {
  if (anim) document.documentElement.dataset.labAnim = "1";
  else delete document.documentElement.dataset.labAnim;
}
applyAnim(initial.anim);

(window as unknown as { __LAB__: unknown }).__LAB__ = {
  slug: registry.slug,
  directions: DIRECTION_IDS,
  surfaces: SURFACE_IDS,
  keys: KIT_KEYS,
  names: Object.fromEntries(DIRECTION_IDS.map((id) => [id, KIT_META[id].name])),
  labels: Object.fromEntries(registry.surfaces.map((surface) => [surface.id, surface.label])),
  storyId: registry.storyId,
  build: LAB_BUILD,
};

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

  const surface = state.view === "board" ? null : state.view;
  const page = (
    <>
      <ThemeSync theme={state.theme} />
      {state.chrome ? <LabToolbar state={state} onChange={change} /> : null}
      {surface === null || state.direction === "all" ? (
        <Board direction={state.direction} view={state.view} theme={state.theme} anim={state.anim} proposal={state.proposal} />
      ) : error ? (
        <KitProblem id={kitId} error={error} />
      ) : kit ? (
        <KitBoundary key={shownKitId} id={shownKitId}>
          <SurfaceView kit={kit} surface={surface} />
        </KitBoundary>
      ) : null}
    </>
  );
  return state.proposal ? (
    <AvatarInitialProvider>
      <div className="design-proposal-theme">{page}</div>
    </AvatarInitialProvider>
  ) : (
    page
  );
}

const queryClient = createLabQueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LabProviders client={queryClient}>
      <Lab />
    </LabProviders>
  </StrictMode>,
);
`;
