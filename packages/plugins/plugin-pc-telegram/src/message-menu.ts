export const QUICK_REACTIONS = ["❤️", "👍", "👎", "🔥", "🥰", "👏", "😁"] as const;

export const MORE_REACTIONS = ["😂", "😮", "😢", "🎉", "💩", "🙏", "👌", "😍", "💯", "🤣", "🤔", "😴"] as const;

const REACTIONS = new Set<string>([...QUICK_REACTIONS, ...MORE_REACTIONS]);

export type TelegramMessageAction =
  | { op: "react"; messageId: string; emoji: string }
  | { op: "pin"; messageId: string; unpin: boolean }
  | { op: "delete"; messageIds: string[]; revoke: boolean }
  | { op: "forward"; messageIds: string[]; targetPeerId: string };

export function isTelegramMessageId(value: string): boolean {
  return /^\d{1,16}$/.test(value) && Number(value) > 0;
}

export function telegramMessageIds(values: unknown, limit = 20): string[] {
  if (!Array.isArray(values)) return [];
  const ids: string[] = [];
  const cap = Math.max(1, Math.min(30, Math.floor(limit) || 20));
  for (const value of values) {
    const id = typeof value === "string" ? value.trim() : "";
    if (!isTelegramMessageId(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= cap) break;
  }
  return ids;
}

export function reactionEmoji(value: string): string | null {
  const emoji = value.trim();
  return REACTIONS.has(emoji) ? emoji : null;
}

export function menuPosition(
  anchor: { x: number; y: number },
  bounds: { width: number; height: number },
  size: { width: number; height: number },
): { left: number; top: number } {
  const width = Number.isFinite(bounds.width) ? bounds.width : 0;
  const height = Number.isFinite(bounds.height) ? bounds.height : 0;
  const maxLeft = Math.max(8, width - size.width - 8);
  const maxTop = Math.max(8, height - size.height - 8);
  const left = Math.min(Math.max(8, anchor.x), maxLeft);
  const top = Math.min(Math.max(8, anchor.y), maxTop);
  return {
    left: Number.isFinite(left) ? left : 8,
    top: Number.isFinite(top) ? top : 8,
  };
}
