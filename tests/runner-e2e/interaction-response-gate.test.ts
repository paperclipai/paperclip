import { expect, it, vi } from "vitest";
import { holdInteractionResponse } from "./interaction-response-gate.js";

it("keeps the tool response in flight until the real card is accepted", async () => {
  let status = "pending";
  let release!: () => void;
  const pause = vi.fn(() => new Promise<void>((r) => { release = r; }));
  let returned = false;
  const pending = holdInteractionResponse({ loadStatus: async () => status, deadlineAt: Infinity, pause }).then((s) => { returned = true; return s; });
  await Promise.resolve(); await Promise.resolve();
  expect(returned).toBe(false);
  status = "accepted"; release();
  await expect(pending).resolves.toBe("accepted");
});
it("bounds a missed browser response instead of claiming overlap passed", async () => {
  let time = 0;
  await expect(holdInteractionResponse({ loadStatus: async () => "pending", deadlineAt: 2,
    now: () => time, pause: async () => { time++; } })).rejects.toThrow("fixture timed out");
});
