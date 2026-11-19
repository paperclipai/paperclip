export const TG_CSS = `
.tg-shell {
  box-sizing: border-box;
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  height: 100%;
  margin: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  background: var(--background-color);
  color: var(--foreground);
  color-scheme: dark;
  font-family: var(--font-sans);
  font-size: 16px;
  font-weight: 400;
  line-height: 1.3125;
  --surface-color: var(--card);
  --background-color: var(--background);
  --body-background-color: var(--background);
  --border-color: var(--border);
  --primary-color: var(--primary);
  --primary-text-color: var(--primary-foreground, var(--foreground));
  --secondary-text-color: var(--muted-foreground);
  --secondary-color: var(--muted-foreground);
  --danger-color: var(--destructive);
  --input-search-border-color: var(--input);
  --message-highlighting-color: color-mix(in oklch, var(--primary) 40%, transparent);
  --message-out-time-color: color-mix(in srgb, var(--primary-text-color) 60%, transparent);
}
.tg-shell *,
.tg-shell *::before,
.tg-shell *::after { box-sizing: border-box; }
.tg-shell button,
.tg-shell input,
.tg-shell textarea {
  font-family: inherit;
  font-size: inherit;
  font-weight: inherit;
  line-height: inherit;
  color: inherit;
}
.tg-shell a { color: inherit; text-decoration: none; }
.tg-shell svg { display: block; max-width: none; }
.tg-list {
  flex: 0 0 360px;
  width: 360px;
  max-width: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface-color);
  border-right: 1px solid var(--border-color);
}
.tg-shell.is-narrow .tg-list {
  flex: 1 1 auto;
  width: 100%;
  border-right: 0;
}
.tg-thread {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--background-color);
}
.tg-jump {
  position: absolute;
  right: 16px;
  bottom: 76px;
  z-index: 4;
  min-width: 36px;
  height: 36px;
  padding: 0 10px;
  border: 0;
  border-radius: 18px;
  background: var(--surface-color);
  color: var(--primary-text-color);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
}
.tg-search { flex: 0 0 auto; padding: 8px 10px; }
.tg-search-field { position: relative; display: block; height: 36px; }
.tg-search-icon {
  position: absolute;
  left: 10px;
  top: 8px;
  width: 20px;
  height: 20px;
  color: var(--secondary-text-color);
  pointer-events: none;
}
.tg-search-icon svg { width: 20px; height: 20px; }
.tg-search-input {
  width: 100%;
  height: 36px;
  border-radius: 18px;
  border: 0;
  background: var(--background-color);
  color: var(--primary-text-color);
  padding: 0 12px 0 36px;
  font-size: 15px;
  outline: none;
}
.tg-search-input::placeholder { color: var(--secondary-text-color); }
.tg-rows { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.tg-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 58px;
  padding: 6px 12px;
  color: inherit;
  text-decoration: none;
}
.tg-row:hover { background: rgba(255, 255, 255, 0.04); }
.tg-row.is-selected,
.tg-row.is-selected:hover { background: rgba(255, 255, 255, 0.08); }
.tg-row.is-selected .tg-badge { background: var(--primary-color); color: var(--primary-text-color); }
.tg-avatar {
  position: relative;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--primary-text-color);
  font-size: 16px;
  font-weight: 500;
  line-height: 1;
  background-size: cover;
  background-position: center;
}
.tg-avatar.has-photo { color: transparent; }
.tg-online {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 12px;
  height: 12px;
  box-sizing: border-box;
  border-radius: 50%;
  background: var(--chart-2);
  border: 2px solid var(--background-color);
}
.tg-avatar svg { width: 22px; height: 22px; }
.tg-avatar-top {
  width: 34px;
  height: 34px;
  flex-basis: 34px;
  font-size: 14px;
}
.tg-avatar-top svg { width: 18px; height: 18px; }
.tg-row-body { flex: 1 1 auto; min-width: 0; }
a.tg-row-body { color: inherit; text-decoration: none; }
.tg-row-top,
.tg-row-bottom {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.tg-row-bottom { margin-top: 2px; }
.tg-row-name,
.tg-row-preview {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tg-row-name { font-size: 15px; font-weight: 500; color: var(--primary-text-color); }
.tg-row-preview { font-size: 14px; font-weight: 400; color: var(--secondary-text-color); }
.tg-row-time { flex-shrink: 0; font-size: 12px; font-weight: 400; color: var(--secondary-text-color); }
.tg-badge {
  flex-shrink: 0;
  box-sizing: border-box;
  height: 22px;
  min-width: 22px;
  padding: 0 7px;
  border-radius: 11px;
  background: var(--primary-color);
  color: var(--primary-text-color);
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  text-align: center;
}
.tg-list-empty,
.tg-empty {
  flex: 1 1 auto;
  display: grid;
  place-items: center;
  min-height: 0;
  color: var(--secondary-text-color);
  font-size: 14px;
  font-weight: 400;
  text-align: center;
  padding: 16px;
}
.tg-topbar {
  flex: 0 0 48px;
  height: 48px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  background: var(--surface-color);
  border-bottom: 1px solid var(--border-color);
}
.tg-back {
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  display: grid;
  place-items: center;
  color: var(--primary-text-color);
  background: transparent;
  border: 0;
  padding: 0;
}
.tg-peer-btn,
.tg-avatar-btn {
  border: 0;
  background: transparent;
  padding: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.tg-avatar-btn { border-radius: 50%; line-height: 0; }
.tg-peer-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1 1 auto;
}
.tg-peer-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.tg-peer-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 16px;
  font-weight: 500;
  color: var(--primary-text-color);
}
.tg-peer-status {
  font-size: 13px;
  font-weight: 400;
  color: var(--secondary-text-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tg-peer-status.is-online { color: var(--chart-2); }
.tg-info-scrim {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 18px 12px;
  overflow: auto;
  background: rgba(0, 0, 0, 0.55);
}
.tg-info {
  width: min(380px, 100%);
  max-height: calc(100% - 8px);
  overflow: auto;
  border-radius: 16px;
  background: var(--surface-color);
  color: var(--primary-text-color);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
}
.tg-info-bar {
  height: 52px;
  display: flex;
  align-items: center;
  padding: 0 4px;
}
.tg-info-close {
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 20px;
  background: transparent;
  color: var(--primary-text-color);
  display: grid;
  place-items: center;
  cursor: pointer;
}
.tg-info-title {
  flex: 1 1 auto;
  margin-right: 40px;
  text-align: center;
  font-size: 16px;
  font-weight: 500;
}
.tg-info-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 4px 16px 18px;
}
.tg-avatar-hero {
  width: 120px;
  height: 120px;
  flex-basis: 120px;
  font-size: 42px;
}
.tg-avatar-hero svg { width: 56px; height: 56px; }
.tg-avatar-hero .tg-online { width: 18px; height: 18px; border-width: 3px; }
.tg-info-name {
  max-width: 100%;
  font-size: 20px;
  font-weight: 500;
  text-align: center;
  overflow-wrap: anywhere;
}
.tg-info-seen { font-size: 14px; color: var(--secondary-text-color); }
.tg-info-seen.is-online { color: var(--chart-2); }
.tg-info-block { padding: 8px 16px 14px; }
.tg-info-value {
  font-size: 15px;
  line-height: 1.35;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.tg-info-label { margin-top: 2px; font-size: 13px; color: var(--secondary-text-color); }
.tg-shell a.tg-task {
  margin-left: auto;
  flex: 0 0 auto;
  font-size: 13px;
  font-weight: 400;
  color: var(--secondary-text-color);
}
.tg-offline {
  flex: 0 0 auto;
  padding: 6px 12px;
  background: var(--surface-color);
  color: var(--secondary-text-color);
  font-size: 13px;
}
.tg-feed {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 12px 16px 8px;
  overflow-anchor: none;
  background-color: var(--background-color);
  background-image: radial-gradient(rgba(255, 255, 255, 0.045) 0.6px, transparent 0.7px);
  background-size: 22px 22px;
}
.tg-history {
  position: sticky;
  top: 8px;
  z-index: 3;
  height: 0;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.tg-history i {
  width: 18px;
  height: 18px;
  margin-top: 2px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.28);
  border-top-color: var(--primary-text-color);
  animation: tg-spin 0.7s linear infinite;
}
@keyframes tg-spin { to { transform: rotate(360deg); } }
.tg-day { display: flex; flex-direction: column; width: 100%; }
.tg-date {
  position: sticky;
  top: 6px;
  z-index: 2;
  align-self: center;
  margin: 6px 0 10px;
  padding: 2px 8px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.45);
  color: var(--muted-foreground);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
}
.tg-group {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  margin: 0 0 8px;
  max-width: 100%;
}
.tg-group.out { align-items: flex-end; }
.tg-bubble {
  width: fit-content;
  max-width: min(480px, 78%);
  padding: 6px 10px 5px;
  border-radius: 16px;
  color: var(--primary-text-color);
  font-size: 15px;
  font-weight: 400;
  line-height: 1.3;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tg-feed.is-compact .tg-bubble { max-width: calc(100% - 24px); }
.tg-bubble.in { background: var(--surface-color); }
.tg-bubble.out { background: var(--primary-color); margin-inline-start: auto; }
.tg-bubble.in.first { border-bottom-left-radius: 5px; }
.tg-bubble.in.middle { border-top-left-radius: 5px; border-bottom-left-radius: 5px; }
.tg-bubble.in.last { border-top-left-radius: 5px; }
.tg-bubble.out.first { border-bottom-right-radius: 5px; }
.tg-bubble.out.middle { border-top-right-radius: 5px; border-bottom-right-radius: 5px; }
.tg-bubble.out.last { border-top-right-radius: 5px; }
.tg-bubble-time {
  float: right;
  margin: 5px 0 -2px 10px;
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
}
.tg-forward {
  display: block;
  margin: 0 0 3px;
  padding-left: 7px;
  border-left: 2px solid var(--primary-color);
  color: var(--accent);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.25;
}
.tg-bubble.out .tg-forward {
  border-left-color: rgba(255, 255, 255, 0.9);
  color: var(--primary-text-color);
}
.tg-bubble.in .tg-bubble-time { color: var(--secondary-text-color); }
.tg-bubble.out .tg-bubble-time { color: rgba(255, 255, 255, 0.72); }
.tg-composer-wrap {
  flex: 0 0 auto;
  background: var(--surface-color);
  border-top: 1px solid var(--border-color);
  padding: 8px 10px;
}
.tg-composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.tg-composer-input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 40px;
  max-height: 160px;
  border: 0;
  border-radius: 20px;
  background: var(--background-color);
  color: var(--primary-text-color);
  padding: 9px 14px;
  resize: none;
  outline: none;
  overflow-y: hidden;
  font-size: 15px;
}
.tg-composer-input::placeholder { color: var(--secondary-text-color); }
.tg-send {
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  border: 0;
  border-radius: 50%;
  padding: 0;
  display: grid;
  place-items: center;
  background: var(--primary-color);
  color: var(--primary-text-color);
  cursor: pointer;
}
.tg-send:disabled { background: var(--border-color); color: var(--secondary-text-color); cursor: default; }
.tg-send-error {
  color: var(--danger-color);
  font-size: 13px;
  padding: 2px 8px 4px;
}
.tg-reply {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 4px 6px;
  padding: 4px 4px 4px 8px;
  border-left: 2px solid var(--primary-color);
  color: var(--primary-text-color);
}
.tg-reply-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--muted-foreground);
}
.tg-reply-x {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  color: var(--secondary-text-color);
  cursor: pointer;
}
.tg-selectbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--surface-color);
  border-top: 1px solid var(--border-color);
}
.tg-selectbar span { flex: 1 1 auto; text-align: center; font-size: 14px; }
.tg-selectbar button {
  border: 0;
  background: transparent;
  color: var(--primary-text-color);
  font-size: 14px;
  cursor: pointer;
}
.tg-selectbar button:disabled { color: var(--secondary-text-color); cursor: default; }
.tg-selectbar button.is-danger { color: var(--danger-color); }
.tg-bubble { cursor: default; }
.tg-bubble.is-picked { outline: 2px solid var(--primary-color); }
.tg-react-badge {
  display: inline-block;
  margin: 4px 0 0 6px;
  padding: 0 6px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.28);
  font-size: 14px;
  line-height: 20px;
}
.tg-menu-scrim { position: absolute; inset: 0; z-index: 20; }
.tg-menu-stack {
  position: absolute;
  z-index: 21;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 220px;
}
.tg-reacts {
  display: flex;
  align-items: center;
  gap: 0;
  height: 44px;
  padding: 0 4px;
  border-radius: 22px;
  background: rgba(32, 32, 34, 0.98);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
.tg-reacts button, .tg-react-grid button {
  border: 0;
  background: transparent;
  cursor: pointer;
  border-radius: 8px;
  font-size: 22px;
  line-height: 1;
}
.tg-reacts button { width: 26px; height: 36px; padding: 0; }
.tg-reacts button:hover, .tg-react-grid button:hover, .tg-menu button:hover { background: rgba(255, 255, 255, 0.08); }
.tg-react-more {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--primary-text-color);
}
.tg-react-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 2px;
  padding: 8px;
  border-radius: 16px;
  background: rgba(32, 32, 34, 0.98);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
.tg-react-grid button { height: 36px; }
.tg-menu {
  border-radius: 12px;
  background: rgba(32, 32, 34, 0.98);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  padding: 6px 0;
  overflow: hidden;
}
.tg-menu button {
  width: 100%;
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 14px;
  border: 0;
  background: transparent;
  color: var(--primary-text-color);
  font-size: 15px;
  cursor: pointer;
  text-align: start;
}
.tg-menu button.is-danger, .tg-menu button.is-danger svg { color: var(--danger-color); }
.tg-menu button:disabled { color: var(--secondary-text-color); cursor: default; }
.tg-menu svg { flex: 0 0 20px; }
.tg-forward-list { max-height: 240px; overflow-y: auto; }
`;
