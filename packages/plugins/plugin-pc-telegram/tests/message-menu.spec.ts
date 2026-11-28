import { describe, expect, it } from "vitest";
import {
  isTelegramMessageId,
  menuPosition,
  reactionEmoji,
  telegramMessageIds,
} from "../src/message-menu.js";

describe("message menu", () => {
  it("accepts telegram message ids and drops everything else", () => {
    expect(isTelegramMessageId("40")).toBe(true);
    expect(isTelegramMessageId("0")).toBe(false);
    expect(isTelegramMessageId("note")).toBe(false);
    expect(telegramMessageIds(["4", "4", "note", "0", "12"], 3)).toEqual(["4", "12"]);
  });

  it("allows only the menu reactions", () => {
    expect(reactionEmoji("❤️")).toBe("❤️");
    expect(reactionEmoji("🚀")).toBeNull();
    expect(reactionEmoji("")).toBeNull();
  });

  it("keeps the menu inside the messenger", () => {
    expect(menuPosition({ x: 400, y: 20 }, { width: 480, height: 640 }, { width: 220, height: 320 })).toEqual({
      left: 252,
      top: 20,
    });
    expect(menuPosition({ x: -10, y: 900 }, { width: 320, height: 400 }, { width: 220, height: 320 })).toEqual({
      left: 8,
      top: 72,
    });
  });
});
