import type { MouseEvent } from "react";

export function openInPlace(event: MouseEvent<HTMLAnchorElement>, href: string, onOpen: (href: string) => void) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onOpen(href);
}
