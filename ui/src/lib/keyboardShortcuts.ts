export const KEYBOARD_SHORTCUT_TEXT_INPUT_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
  "[role='textbox']",
  "[role='combobox']",
].join(", ");

const MODIFIER_ONLY_KEYS = new Set(["Shift", "Meta", "Control", "Alt"]);

export type InboxQuickArchiveKeyAction = "ignore" | "archive" | "disarm";
export type IssueDetailGoKeyAction = "ignore" | "arm" | "navigate_inbox" | "focus_comment" | "disarm";

export function isKeyboardShortcutTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return !!target.closest(KEYBOARD_SHORTCUT_TEXT_INPUT_SELECTOR);
}

export function hasBlockingShortcutDialog(root: ParentNode = document): boolean {
  return !!root.querySelector("[role='dialog'][aria-modal='true']");
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
