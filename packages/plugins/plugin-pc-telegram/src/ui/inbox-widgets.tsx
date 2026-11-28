import { useLayoutEffect, useState } from "react";
import { avatarPair, formatLastSeen, initialLetter, parseTime } from "./inbox-model.js";
import { isRuLocale, uiText } from "./locale.js";
import type { PresenceView } from "./inbox-thread.js";

export function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 16.5 20 20.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <path d="M14.5 5.5 8 12l6.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}

export function MenuIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.1" fill="currentColor" />
      <path fill="currentColor" d="M5.8 18.4c.9-2.7 3.1-4.1 6.2-4.1s5.3 1.4 6.2 4.1c.2.5-.2.9-.7.9H6.5c-.5 0-.9-.4-.7-.9z" />
    </svg>
  );
}

export function forwardLine(forward: { kind?: string | null; name?: string | null; author?: string | null }): string {
  const clean = (value: string | null | undefined) => {
    const text = (value ?? "").replace(/\s+/g, " ").trim();
    if (!text || /^\d+$/.test(text)) return "";
    return text.slice(0, 128);
  };
  const name = clean(forward.name);
  const author = clean(forward.author);
  const fromPlace = forward.kind === "channel" || forward.kind === "chat";
  if (!name) return uiText("Forwarded");
  const line = fromPlace
    ? (isRuLocale() ? `Переслано из ${name}` : `Forwarded from ${name}`)
    : (isRuLocale() ? `Переслано от ${name}` : `Forwarded from ${name}`);
  if (!author || !fromPlace) return line;
  return `${line}, ${author}`;
}

function genericName(name: string): boolean {
  const trimmed = name.trim();
  return !trimmed || trimmed === "Telegram" || /^\d{5,}$/.test(trimmed);
}

export function safePhoto(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("data:image/") || value.length > 480_000) return null;
  if (/[\s"'()]/.test(value)) return null;
  return value;
}

export function presenceText(presence: PresenceView, ru: boolean): string {
  const code = presence?.code ?? "";
  if (code === "online") return uiText("online");
  if (code === "recently") return uiText("last seen recently");
  if (code === "last_week") return uiText("last seen within a week");
  if (code === "last_month") return uiText("last seen within a month");
  if (code === "offline") {
    const at = presence?.at ? parseTime(presence.at) : null;
    if (!at) return uiText("last seen a long time ago");
    return formatLastSeen(at, ru);
  }
  return "";
}

export function Avatar({
  id,
  name,
  photo,
  topbar = false,
  hero = false,
  online = false,
}: {
  id: string;
  name: string;
  photo?: string | null;
  topbar?: boolean;
  hero?: boolean;
  online?: boolean;
}) {
  const generic = genericName(name);
  const [from, to] = avatarPair(id || name);
  const src = safePhoto(photo);
  const size = hero ? "tg-avatar tg-avatar-hero" : topbar ? "tg-avatar tg-avatar-top" : "tg-avatar";
  return (
    <span
      className={src ? `${size} has-photo` : size}
      style={{ backgroundImage: src ? `url("${src}")` : `linear-gradient(to bottom, ${from}, ${to})` }}
      aria-hidden="true"
    >
      {src ? null : generic ? <PersonIcon /> : initialLetter(name)}
      {online ? <span className="tg-online" /> : null}
    </span>
  );
}

export function resizeComposer(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  const style = window.getComputedStyle(element);
  const fontSize = Number.parseFloat(style.fontSize) || 16;
  const parsedLine = Number.parseFloat(style.lineHeight);
  const line = Number.isFinite(parsedLine) ? parsedLine : fontSize * 1.3125;
  const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  const max = line * 8 + padding;
  const next = Math.min(Math.max(element.scrollHeight, 40), max);
  element.style.height = `${next}px`;
  element.style.overflowY = element.scrollHeight > max + 1 ? "auto" : "hidden";
}

function isHostBack(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const link = element instanceof HTMLAnchorElement ? element : element.querySelector("a");
  if (!(link instanceof HTMLAnchorElement)) return false;
  const text = (link.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text !== "Back" && text !== "Назад") return false;
  return /\/dashboard\/?$/.test(link.getAttribute("href") ?? "");
}

export function hideHostBack(shell: HTMLElement): () => void {
  const hidden: HTMLElement[] = [];
  let node: HTMLElement | null = shell;
  for (let depth = 0; node && depth < 8; depth += 1) {
    let previous = node.previousElementSibling;
    while (previous) {
      if (isHostBack(previous)) {
        previous.style.display = "none";
        hidden.push(previous);
      }
      previous = previous.previousElementSibling;
    }
    node = node.parentElement;
  }
  return () => {
    for (const element of hidden) element.style.display = "";
  };
}

export function useObservedWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return undefined;
    const read = (next: number) => {
      setWidth((current) => (current === next ? current : next));
    };
    read(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      read(entries[0]?.contentRect.width ?? element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

export function profileOnlineClass(presence: PresenceView): string {
  return presence?.code === "online" ? "tg-info-seen is-online" : "tg-info-seen";
}
