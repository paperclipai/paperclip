export const KEYBOARD_SHORTCUT_TEXT_INPUT_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
  "[role='textbox']",
  "[role='combobox']",
].join(", ");

const PAGE_SEARCH_SHORTCUT_SELECTOR = "[data-page-search-target='true']";
const MODIFIER_ONLY_KEYS = new Set(["Shift", "Meta", "Control", "Alt"]);

export type InboxQuickArchiveKeyAction = "ignore" | "archive" | "disarm";
export type InboxUndoArchiveKeyAction = "ignore" | "undo_archive";
export type IssueDetailGoKeyAction = "ignore" | "arm" | "navigate_inbox" | "focus_comment" | "disarm";

export function isKeyboardShortcutTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return !!target.closest(KEYBOARD_SHORTCUT_TEXT_INPUT_SELECTOR);
}

export function hasBlockingShortcutDialog(root: ParentNode = document): boolean {
  return !!root.querySelector("[role='dialog'][aria-modal='true']");
}

function isVisibleShortcutTarget(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  if ("disabled" in element && typeof element.disabled === "boolean" && element.disabled) return false;
  if (element.closest("[hidden], [aria-hidden='true'], [inert]")) return false;
  if (element.closest("[role='dialog'][aria-modal='true']")) return false;

  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;

  return element.getClientRects().length > 0 || element === document.activeElement;
}

export function findPageSearchShortcutTarget(root: ParentNode = document): HTMLElement | null {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(PAGE_SEARCH_SHORTCUT_SELECTOR));
  return candidates.find((candidate) => isVisibleShortcutTarget(candidate)) ?? null;
}

export function focusPageSearchShortcutTarget(root: ParentNode = document): boolean {
  const target = findPageSearchShortcutTarget(root);
  if (!target) return false;

  target.focus();
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.select();
  }
  return true;
}

export function shouldBlurPageSearchOnEnter({
  key,
  isComposing,
}: {
  key: string;
  isComposing: boolean;
}): boolean {
  return key === "Enter" && !isComposing;
}

export function shouldBlurPageSearchOnEscape({
  key,
  isComposing,
  currentValue,
}: {
  key: string;
  isComposing: boolean;
  currentValue: string;
}): boolean {
  return key === "Escape" && !isComposing && currentValue.length === 0;
}

export function isModifierOnlyKey(key: string): boolean {
  return MODIFIER_ONLY_KEYS.has(key);
}

export function resolveInboxQuickArchiveKeyAction({
  armed,
  defaultPrevented,
  key,
  metaKey,
  ctrlKey,
  altKey,
  target,
  hasOpenDialog,
}: {
  armed: boolean;
  defaultPrevented: boolean;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  hasOpenDialog: boolean;
}): InboxQuickArchiveKeyAction {
  if (!armed) return "ignore";
  if (defaultPrevented) return "ignore";
  if (metaKey || ctrlKey || altKey || isModifierOnlyKey(key)) return "ignore";
  if (hasOpenDialog || isKeyboardShortcutTextInputTarget(target)) return "ignore";
  if (key.toLowerCase() === "y") return "archive";
  return "ignore";
}

export function resolveInboxUndoArchiveKeyAction({
  hasUndoableArchive,
  defaultPrevented,
  key,
  metaKey,
  ctrlKey,
  altKey,
  target,
  hasOpenDialog,
}: {
  hasUndoableArchive: boolean;
  defaultPrevented: boolean;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  hasOpenDialog: boolean;
}): InboxUndoArchiveKeyAction {
  if (!hasUndoableArchive) return "ignore";
  if (defaultPrevented) return "ignore";
  if (metaKey || ctrlKey || altKey || isModifierOnlyKey(key)) return "ignore";
  if (hasOpenDialog || isKeyboardShortcutTextInputTarget(target)) return "ignore";
  if (key === "u") return "undo_archive";
  return "ignore";
}

export function resolveIssueDetailGoKeyAction({
  armed,
  defaultPrevented,
  key,
  metaKey,
  ctrlKey,
  altKey,
  target,
  hasOpenDialog,
}: {
  armed: boolean;
  defaultPrevented: boolean;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  hasOpenDialog: boolean;
}): IssueDetailGoKeyAction {
  if (defaultPrevented) return armed ? "disarm" : "ignore";
  if (metaKey || ctrlKey || altKey || isModifierOnlyKey(key)) return "ignore";
  if (hasOpenDialog || isKeyboardShortcutTextInputTarget(target)) {
    return armed ? "disarm" : "ignore";
  }

  const normalizedKey = key.toLowerCase();
  if (!armed) return normalizedKey === "g" ? "arm" : "ignore";
  if (normalizedKey === "i") return "navigate_inbox";
  if (normalizedKey === "c") return "focus_comment";
  if (normalizedKey === "g") return "arm";
  return "disarm";
}
