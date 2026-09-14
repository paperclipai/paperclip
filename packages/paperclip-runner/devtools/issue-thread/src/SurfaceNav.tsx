import type { CapabilitySurface } from "./route";
import { Icon } from "./Icons";

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
export interface CapabilityChatHistoryItem {
  sessionId: string;
  identifier: string;
  title: string;
  updatedAt: string;
  current: boolean;
}

export function SurfaceNav({ surface, history = [], activeSessionId = null, onNewChat, onSelectHistory }: {
  surface: CapabilitySurface;
  history?: CapabilityChatHistoryItem[];
  activeSessionId?: string | null;
  onNewChat?: () => void;
  onSelectHistory?: (sessionId: string) => void;
}) {
  return (
    <aside className="pit-surface-nav" aria-label="Runner navigation" data-testid="surface-nav">
      <div className="pit-sidebar-brand"><Icon name="activity" /><span>Runner lab</span></div>
      <nav className="pit-sidebar-primary" aria-label="Capability surfaces">
        <a className="pit-surface-link" href="#/issue/hb-baseline" aria-current={surface === "issue" ? "page" : undefined} data-testid="surface-issue-link">
          <Icon name="timeline" /><span>Scenario explorer</span>
        </a>
        <button type="button" className="pit-surface-link" onClick={onNewChat} disabled={onNewChat === undefined} data-testid="surface-chat-link">
          <Icon name="spark" /><span>New chat</span>
        </button>
      </nav>
      {surface === "chat" ? (
        <section className="pit-session-history" aria-labelledby="session-history-title">
          <h2 id="session-history-title">Session history</h2>
          <div className="pit-session-history-list">
            {history.map((item) => (
              <button type="button" key={item.sessionId} className="pit-session-history-item" data-selected={activeSessionId === item.sessionId} onClick={() => onSelectHistory?.(item.sessionId)}>
                <span className="pit-session-history-title">{item.title}</span>
                <span>{item.identifier}{item.current ? " · current" : ""}</span>
              </button>
            ))}
            {history.length === 0 ? <p className="pit-muted">No chats yet.</p> : null}
          </div>
        </section>
      ) : null}
    </aside>
  );
}
