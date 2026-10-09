import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useConnectivity, type ConnectivityStatus } from "@/lib/connectivity";

/** Trouble must last this long before the banner appears, so one blip never flickers. */
export const BANNER_SHOW_DELAY_MS = 2_000;
/** How long "Back online" stays after a recovery the user saw. */
export const BACK_ONLINE_VISIBLE_MS = 3_000;

export type ConnectionBannerView = "hidden" | "reconnecting" | "offline" | "back_online";

/**
 * Which banner to show. Reconnecting/offline only after `BANNER_SHOW_DELAY_MS`
 * of continuous trouble; "Back online" only after an outage the banner showed.
 */
export function connectionBannerView(input: {
  status: ConnectivityStatus;
  troubleSince: number | null;
  recoveredAt: number | null;
  shownForOutage: boolean;
  now: number;
}): ConnectionBannerView {
  if (input.status !== "online") {
    const troubleFor = input.troubleSince === null ? 0 : input.now - input.troubleSince;
    if (troubleFor < BANNER_SHOW_DELAY_MS) return "hidden";
    return input.status;
  }
  if (input.shownForOutage && input.recoveredAt !== null && input.now - input.recoveredAt < BACK_ONLINE_VISIBLE_MS) {
    return "back_online";
  }
  return "hidden";
}

export function pendingWritesCopy(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 change will send when you’re back online."
    : `${count} changes will send when you’re back online.`;
}

// Full-page reconnect screens (CloudAccessGate before the board opens) already
// say the same thing; the banner stays hidden while one is mounted.
let suppressors = 0;
const suppressionListeners = new Set<() => void>();
function setSuppressors(next: number) {
  suppressors = next;
  for (const listener of [...suppressionListeners]) listener();
}
function subscribeSuppression(listener: () => void) {
  suppressionListeners.add(listener);
  return () => {
    suppressionListeners.delete(listener);
  };
}

/** Hide the banner while the calling component is mounted. */
export function useSuppressConnectionBanner(active = true) {
  useEffect(() => {
    if (!active) return;
    setSuppressors(suppressors + 1);
    return () => setSuppressors(suppressors - 1);
  }, [active]);
}

/**
 * The single app-level connection indicator. Replaces per-surface
 * outage errors: while the server is unreachable, loaded content stays on
 * screen and this banner explains why nothing is updating.
 */
export function ConnectionStatusBanner() {
  const { status, troubleSince, recoveredAt, pendingWrites } = useConnectivity();
  const [now, setNow] = useState(() => Date.now());
  const shownForOutage = useRef(false);
  const suppressed = useSyncExternalStore(subscribeSuppression, () => suppressors > 0, () => false);

  const view = connectionBannerView({ status, troubleSince, recoveredAt, shownForOutage: shownForOutage.current, now });
  if (!suppressed && (view === "reconnecting" || view === "offline")) shownForOutage.current = true;

  // Re-render when the view can next change: when the show delay elapses, or
  // when "Back online" should disappear.
  useEffect(() => {
    let wakeAt: number | null = null;
    if (status !== "online" && troubleSince !== null && view === "hidden") {
      wakeAt = troubleSince + BANNER_SHOW_DELAY_MS;
    } else if (view === "back_online" && recoveredAt !== null) {
      wakeAt = recoveredAt + BACK_ONLINE_VISIBLE_MS;
    }
    if (wakeAt === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, wakeAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [status, troubleSince, recoveredAt, view]);

  // Keep `now` current when the connectivity state changes.
  useEffect(() => {
    setNow(Date.now());
  }, [status, troubleSince, recoveredAt]);

  useEffect(() => {
    if (view === "hidden" && status === "online") shownForOutage.current = false;
  }, [view, status]);

  if (view === "hidden" || suppressed) return null;
  return <ConnectionStatusMessage view={view} pendingWrites={pendingWrites} />;
}

/** The banner's presentation, for a view that is not hidden. */
export function ConnectionStatusMessage({
  view,
  pendingWrites = 0,
}: {
  view: Exclude<ConnectionBannerView, "hidden">;
  pendingWrites?: number;
}) {
  const pending = view === "back_online" ? null : pendingWritesCopy(pendingWrites);
  const message = view === "back_online"
    ? "Back online."
    : view === "offline"
      ? "You’re offline. Reconnecting when your network is back…"
      : "Connection interrupted. Reconnecting automatically…";

  return (
    <div
      role="status"
      aria-live="polite"
      data-connection-status={view}
      className="bg-muted px-4 py-2 text-center text-sm text-muted-foreground"
    >
      {message}
      {pending ? <> {pending}</> : null}
    </div>
  );
}
