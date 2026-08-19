import type { CapabilitySurface } from "./route";

/**
 * Top-level surface switch (Capability plan revision 5).
 *
 * Capability now has two primary paths, not one path with a mode toggle: the
 * preset scenario explorer and a clean-room chat that starts from nothing. They
 * are different jobs, so they get links rather than tabs — the clean-room entry
 * has to be reachable from the landing page without first choosing a scenario.
 *
 * These are real anchors on purpose. The entry must survive a hard refresh, be
 * copyable, and open in a new tab, which a button handler would not give.
 */
export function SurfaceNav({ surface }: { surface: CapabilitySurface }) {
  return (
    <nav className="pit-surface-nav" aria-label="Capability surfaces" data-testid="surface-nav">
      <a
        className="pit-surface-link"
        href="#/issue/hb-baseline"
        aria-current={surface === "issue" ? "page" : undefined}
        data-testid="surface-issue-link"
      >
        Scenario explorer
      </a>
      <a
        className="pit-surface-link"
        href="#/chat"
        aria-current={surface === "chat" ? "page" : undefined}
        data-testid="surface-chat-link"
      >
        New chat
        <span className="pit-surface-note">· clean room</span>
      </a>
    </nav>
  );
}
